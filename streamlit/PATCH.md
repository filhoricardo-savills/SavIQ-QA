# Wiring `saviq_qa_export.py` into `app_v11.py`

Four small edits. Nothing existing is removed; the analysis, the drafts CSV and
the full Excel results all behave exactly as they do now.

Put `saviq_qa_export.py` next to `app_v11.py`.

---

## 1. Import it

Near the other imports at the top:

```python
import saviq_qa_export
```

## 2. Add the tab

Find this line in `render_v11_results`:

```python
    issues_tab, meters_tab, help_tab = st.tabs(['Issue drafts', 'All meters & incomplete checks', 'How to raise an issue'])
```

Replace it with:

```python
    issues_tab, send_tab, meters_tab, help_tab = st.tabs(
        ['Issue drafts', 'Send to Meter QA Review',
         'All meters & incomplete checks', 'How to raise an issue'])
```

## 3. Render the curation table

Immediately **before** the existing `with meters_tab:` line, add:

```python
    with send_tab:
        saviq_qa_export.render_qa_export(st, bundle, drafts, ISSUE_APP_URL)
```

## 4. Loosen one stale caption

In the issue-drafts tab, this line is no longer true:

```python
            st.caption('CSV is for review and copying. Compatibility with the website’s Excel feature has not been verified.')
```

Replace with:

```python
            st.caption('CSV is for review and copying. To send findings into Meter QA Review, '
                       'use the **Send to Meter QA Review** tab, which produces a workbook its importer reads directly.')
```

---

## What the new tab does

1. Lists every issue draft with a tick box, defaulted to **off**.
2. Sets a Savills account for the whole run, overridable per row — a DEXMA token
   does not always map to exactly one Savills account.
3. Suggests an issue type and priority, both editable.
4. Produces an `.xlsx` with one sheet called **Issues**, using the exact column
   headers the QA app's importer recognises.

`Ref` is blank on every row, which the importer reads as "create a new issue".
The draft fingerprint travels in `Tags` as `ref:abc123…`, so if you ever wonder
whether a finding was already raised, search the QA app for that string.

## Dependencies

No new ones. `pandas` and `openpyxl` are already required by `app_v11.py`.

## Keeping the account list honest

`SAVILLS_ACCOUNTS` in `saviq_qa_export.py` duplicates `public.accounts` from the
QA database. It has to: that table is behind row-level security and this app
holds no QA credentials. If an account is added or renamed in the QA app,
update the list here as well — it is one edit, and the QA importer will reject
an unrecognised code rather than guess, so a stale list fails loudly.
