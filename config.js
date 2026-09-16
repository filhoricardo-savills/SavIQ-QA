/* ---------------------------------------------------------------------------
   Supabase connection details.

   Get both from your Supabase project: Project Settings -> API.
   Replace the two placeholder strings below and save.

   The anon key is MEANT to be public. It ships in the page and lives in the
   repo, and that is fine — it identifies the project, it does not grant
   access. What protects the data is the row-level security in
   supabase/schema.sql, which only lets approved Savills addresses read or
   write anything.

   NEVER paste the service_role key here. That one bypasses every rule.
   --------------------------------------------------------------------------- */
window.QA_CONFIG = {
  SUPABASE_URL: "https://bqlvtzjksuvgtlvrstmc.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_1-R8Ox8fElKf7MgHZj8Jcw_bD5JcBP_",

  /* Optional. Where the SavIQ meter-analysis Streamlit app is running.
     Set it and a link to it appears in Setup. Leave it blank and that
     card simply explains the round trip without a button. */
  SAVIQ_ANALYSIS_URL: ""
};
