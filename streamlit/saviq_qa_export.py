"""Curate SavIQ meter findings and export them for Meter QA Review.

Sits alongside app_v11.py. The analysis app finds everything; a person decides
what is worth tracking; this module turns that curated subset into a workbook
the QA app can import.

Deliberately additive: it reads app_v11's draft dictionaries and result rows,
and writes an .xlsx. It performs no API calls, posts nothing, and holds no
credentials.

The sheet it produces is named "Issues" and uses the exact column headers the
QA app's importer recognises. Every row is created as a new issue: the Ref
column is left blank on purpose, because these findings do not yet exist in
the QA app. Re-importing the same file twice would therefore create duplicates
— the QA app's import preview is where that gets caught, and the draft
fingerprint is carried in Tags so an existing issue can be found by searching
for it.
"""
from __future__ import annotations

from datetime import date, timedelta
from io import BytesIO
from typing import Any, Dict, List, Optional

import pandas as pd

# ---------------------------------------------------------------------------
# The Savills accounts, as the QA app knows them.
#
# This list is duplicated from the QA app's database (public.accounts) because
# that table is behind row-level security and this app holds no QA credentials.
# If an account is added or renamed there, update it here too.
# ---------------------------------------------------------------------------
SAVILLS_ACCOUNTS: List[tuple[str, str]] = [
    ("8747", "Savills Offices"),
    ("8830", "60 Dawson St"),
    ("8831", "Grant Thornton"),
    ("8855", "Henderson Park"),
    ("8857", "REAL IS"),
    ("8869", "AM Alpha"),
    ("8871", "DEKA"),
    ("8889", "Union"),
    ("8962", "ILIM"),
    ("8964", "Westend"),
    ("8965", "Avestus"),
    ("8966", "Kennedy Wilson"),
    ("9137", "28 Fitzwilliam Street"),
    ("9587", "Bankside"),
    ("9681", "Aviva"),
    ("9904", "Ironworks"),
    ("9908", "Corum"),
    ("9938", "Swift Square"),
    ("10000", "Cork Mathew Property Limited"),
    ("10012", "Blanchardstown SC"),
    ("10020", "Realty"),
]

ACCOUNT_LABELS = [f"{code} · {name}" for code, name in SAVILLS_ACCOUNTS]
ACCOUNT_CODE_BY_LABEL = {label: code for label, (code, _n) in zip(ACCOUNT_LABELS, SAVILLS_ACCOUNTS)}

# The QA app's fixed vocabularies. These strings must match exactly.
QA_CATEGORIES = ["Manual reads", "Salesforce", "IoT", "Missing data", "Unusual trend"]
QA_PRIORITIES = ["Low", "Medium", "High", "Urgent"]

# The columns the QA importer reads, in the order a reviewer wants to see them.
EXPORT_COLUMNS = [
    "Ref", "Issue", "Account code", "Type", "Priority",
    "Site", "Device name", "SavIQ Device Key",
    "Due date", "Tags", "Detail",
]


def qa_category(findings: str, qa_mode: str) -> str:
    """Map an app_v11 finding tag onto one of the QA app's five issue types.

    The mapping is a starting point, not a verdict — every row is editable in
    the curation table before export.
    """
    tags = (findings or "").lower()
    monthly = qa_mode in ("monthly", "monthly_fallback")

    if "consumption change" in tags:
        return "Unusual trend"
    if "missing hourly readings" in tags:
        # An automated meter that stopped reporting hourly is a logger problem.
        return "IoT"
    if "missing readings" in tags:
        return "Manual reads" if monthly else "Missing data"
    if any(t in tags for t in ("prolonged zero", "reading gaps", "low data availability")):
        return "IoT"
    return "Missing data"


def qa_priority(suggested: str) -> str:
    value = (suggested or "").strip().capitalize()
    return value if value in QA_PRIORITIES else "Medium"


def default_due_date(month_iso: str) -> date:
    """Two weeks from today, which is the QA app's own quick-add default."""
    return date.today() + timedelta(days=14)


def curation_frame(
    drafts: List[Dict[str, Any]],
    results: List[Dict[str, Any]],
    *,
    default_account_code: str,
    due: Optional[date] = None,
) -> pd.DataFrame:
    """Build the editable table a reviewer curates before exporting."""
    mode_by_device = {str(r.get("device_id")): r.get("qa_mode", "") for r in results}
    due_value = due or (date.today() + timedelta(days=14))

    rows = []
    for draft in drafts:
        device_id = str(draft.get("device_id", ""))
        rows.append(
            {
                "Include": False,
                "Issue": draft.get("title", ""),
                "Account code": default_account_code,
                "Type": qa_category(draft.get("findings", ""), mode_by_device.get(device_id, "")),
                "Priority": qa_priority(draft.get("suggested_priority", "")),
                "Site": draft.get("location", ""),
                "Device name": draft.get("meter", ""),
                "SavIQ Device Key": draft.get("device_key", ""),
                "Due date": due_value,
                "Tags": f"saviq, {draft.get('month', '')}, ref:{draft.get('reference', '')}",
                "Detail": draft.get("description", ""),
            }
        )
    return pd.DataFrame(rows, columns=["Include"] + [c for c in EXPORT_COLUMNS if c != "Ref"])


def qa_import_excel_bytes(frame: pd.DataFrame) -> bytes:
    """Write the curated rows as an .xlsx the QA app can import.

    One sheet, named "Issues". Ref is blank on every row, which the importer
    treats as "create a new issue".
    """
    selected = frame[frame["Include"] == True].copy()  # noqa: E712 — pandas mask
    if selected.empty:
        raise ValueError("No rows are ticked for export.")

    selected = selected.drop(columns=["Include"])
    selected.insert(0, "Ref", "")

    # Dates must reach Excel as dates, not timestamps, or the importer sees noise.
    if "Due date" in selected:
        selected["Due date"] = pd.to_datetime(selected["Due date"], errors="coerce").dt.date

    for column in EXPORT_COLUMNS:
        if column not in selected:
            selected[column] = ""
    selected = selected[EXPORT_COLUMNS]

    stream = BytesIO()
    with pd.ExcelWriter(stream, engine="openpyxl") as writer:
        selected.to_excel(writer, sheet_name="Issues", index=False)
        sheet = writer.sheets["Issues"]
        widths = {"A": 8, "B": 52, "C": 13, "D": 16, "E": 11,
                  "F": 24, "G": 28, "H": 22, "I": 12, "J": 30, "K": 90}
        for letter, width in widths.items():
            sheet.column_dimensions[letter].width = width
        sheet.freeze_panes = "A2"
        sheet.auto_filter.ref = sheet.dimensions
    return stream.getvalue()


# ---------------------------------------------------------------------------
# Streamlit surface
# ---------------------------------------------------------------------------
def render_qa_export(st, bundle: Dict[str, Any], drafts: List[Dict[str, Any]],
                     issue_app_url: str) -> None:
    """Curation table plus the download that feeds the QA app's importer."""
    if not drafts:
        st.info("No issue drafts in this run, so there is nothing to send to Meter QA Review.")
        return

    st.write(
        "Tick the findings worth tracking. The analysis flags everything it can see; "
        "this is where a person decides what becomes a real issue."
    )

    default_label = st.session_state.get("v11_qa_account") or ACCOUNT_LABELS[0]
    col1, col2 = st.columns([2, 1])
    with col1:
        chosen = st.selectbox(
            "Savills account these meters belong to",
            ACCOUNT_LABELS,
            index=ACCOUNT_LABELS.index(default_label) if default_label in ACCOUNT_LABELS else 0,
            key="v11_qa_account",
            help="Sets the account on every exported row. Change individual rows in the table below "
                 "if this DEXMA token covers more than one Savills account.",
        )
    with col2:
        due = st.date_input("Due date for exported issues",
                            value=date.today() + timedelta(days=14), key="v11_qa_due")

    default_code = ACCOUNT_CODE_BY_LABEL[chosen]
    signature = f"{bundle.get('month')}|{default_code}|{due}|{len(drafts)}"
    if st.session_state.get("v11_qa_signature") != signature:
        st.session_state["v11_qa_frame"] = curation_frame(
            drafts, bundle.get("results", []), default_account_code=default_code, due=due)
        st.session_state["v11_qa_signature"] = signature

    edited = st.data_editor(
        st.session_state["v11_qa_frame"],
        key="v11_qa_editor",
        width="stretch",
        hide_index=True,
        column_config={
            "Include": st.column_config.CheckboxColumn("Include", help="Send this one to Meter QA Review", width="small"),
            "Issue": st.column_config.TextColumn("Issue", width="large"),
            "Account code": st.column_config.SelectboxColumn(
                "Account", options=[c for c, _n in SAVILLS_ACCOUNTS], width="small"),
            "Type": st.column_config.SelectboxColumn("Type", options=QA_CATEGORIES),
            "Priority": st.column_config.SelectboxColumn("Priority", options=QA_PRIORITIES, width="small"),
            "Due date": st.column_config.DateColumn("Due", width="small"),
            "Detail": st.column_config.TextColumn("Detail (exported, not shown in full)", width="medium"),
        },
        disabled=["Site", "Device name", "SavIQ Device Key", "Tags"],
    )

    chosen_count = int(edited["Include"].sum()) if "Include" in edited else 0
    st.caption(f"{chosen_count} of {len(edited)} findings selected.")

    if chosen_count:
        try:
            payload = qa_import_excel_bytes(edited)
        except (ValueError, ImportError) as exc:
            st.error(f"The workbook could not be prepared: {exc}")
            return
        st.download_button(
            f"Download {chosen_count} issue(s) for Meter QA Review",
            data=payload,
            file_name=f"saviq_for_qa_{bundle['month'][:7]}.xlsx",
            mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            type="primary",
            key="v11_qa_download",
        )
        st.caption(
            "Then open Meter QA Review → **Setup** → **Import issues from Excel**. "
            "It previews every row before writing anything, and never deletes."
        )
        st.link_button("Open Meter QA Review", issue_app_url)
    else:
        st.info("Tick at least one finding to prepare the workbook.")
