# ── CONFIG ──────────────────────────────────────────────────────────────────
# The app fills in PROJECT_ID when you download this notebook from /developer →
# Notebook; choose SCENARIO_ID and POLICY_VERSION_ID yourself (that tab lists them)
# or leave them blank. Leave it all as it is to try the offline demo first.
BASE_URL = "https://wckdrutwkytwcomrlpib.supabase.co/functions/v1/api/v1"
PROJECT_ID = ""          # "" = the first project your key can see
SCENARIO_ID = ""         # a baseline scenario; "" = pick one without disruptions (or create one)
POLICY_VERSION_ID = ""   # a policy snapshot; "" = snapshot the current configuration
SUPPLIER_ID = ""         # a supplier id from your own data, for the disruption examples
API_KEY_NAME = "SURESUITE_API_KEY"   # the Colab secret or environment variable that holds your key; change it to use another of your keys
MODE = "auto"            # "auto" = live when an API key is found, else the offline demo; "live"; "demo"
ACKNOWLEDGE_WARNINGS = False  # True = run anyway when the pre-run data check only warns (missing values use the platform defaults)
