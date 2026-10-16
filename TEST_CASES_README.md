# Cloudnaut Support Desk — Test Cases

This repository ships a manual/automated test-case workbook:

- **`Cloudnaut_Support_Desk_Test_Cases.xlsx`** (repository root) — the deliverable.
- **`scripts/tc_data.py`** — the verified endpoint/role/config inventory and the test-case dataset (source of truth).
- **`scripts/generate_test_cases.py`** — regenerates the workbook from `tc_data.py` using `openpyxl`.

The test cases were derived by reading the actual source (public API `workspace/api`, internal backend `workspace/backend`, shared DB `workspace/database`, frontend `workspace/frontend`, existing Pytest suites, and `docker-compose.yml`). No application source was modified to produce them.

> **Honesty note:** every test starts at `Not Run` with empty Actual Result. A test is only `Pass` after it has genuinely been executed. Source code "looking correct" is **not** a pass.

---

## 1. Workbook structure (10 sheets)

| # | Sheet | What it contains |
|---|-------|------------------|
| 1 | **Test Execution Summary** | KPI block (Total / Not Run / Pass / Fail / Blocked / N/A / Executed / Pass % / Progress %), by-module and by-priority tables, a status pie chart and a module bar chart. All KPIs are live formulas over the Master sheet. |
| 2 | **Master Test Cases** | One row per executable test case, 22 columns in the required order. Dropdowns + conditional formatting. This is the authoritative execution log. |
| 3 | **API Test Cases** | Every public API endpoint mapped to its internal backend endpoint, with method, auth, allowed roles, rules, and related Test Case IDs. |
| 4 | **Authentication and RBAC** | Role × capability permission matrix (built from code), JWT/password facts, and the AUTH/RBAC/PWD test-case rows. |
| 5 | **Request Lifecycle** | Create / list / get / update / assign / status / notes / history + team & access-request test cases. |
| 6 | **Attachments and MinIO** | Upload / download / delete, type & size validation, ownership, and MinIO resilience (unavailable, commit-fail cleanup). |
| 7 | **Database and Integration** | Persistence, constraints, migrations, API↔backend integration and error propagation. |
| 8 | **UI and End-to-End Tests** | Frontend forms/validation/states, live chat, health checks, and full user journeys. |
| 9 | **Test Data and Environment** | Suggested throwaway accounts, environment prerequisites, safe sample payloads, cleanup/safety notes. |
| 10 | **Requirements Traceability** | Endpoint → Test Case ID mapping, source-file hints, coverage flags, and the Not-Implemented / Out-of-Scope list. |

### Master sheet columns (exact order)
`Test Case ID, Module, Feature, API / Endpoint, Test Scenario, Test Case Description, Preconditions, Test Data, Execution Steps, Expected Result, Actual Result, HTTP Status Code Expected, HTTP Status Code Actual, Priority (P0/P1/P2/P3), Test Type, Test Level, Execution Status, Defect ID, Evidence / Screenshot / Log, Automation Status, Source File / Function, Remarks`

### ID conventions
`AUTH-TC-###`, `RBAC-TC-###`, `REQ-TC-###`, `TEAM-TC-###`, `ACC-TC-###`, `ATT-TC-###`, `CHAT-TC-###`, `DB-TC-###`, `UI-TC-###`, `E2E-TC-###`, `PWD-TC-###`, `INFRA-TC-###`, and `OOS-TC-###` (out of scope). IDs are unique and stable across sheets.

---

## 2. How to execute and record test cases

1. Open **`Cloudnaut_Support_Desk_Test_Cases.xlsx`** in Microsoft Excel or LibreOffice Calc.
2. Work from the **Master Test Cases** sheet (or a topical sheet).
3. For each test:
   - Follow **Execution Steps** with the data in **Test Data**.
   - Compare the system behaviour to **Expected Result** and **HTTP Status Code Expected**.
   - Fill in **Actual Result** and **HTTP Status Code Actual**.
   - Set **Execution Status** via the dropdown: `Pass`, `Fail`, `Blocked`, or `Not Applicable`.
   - If it failed, add a **Defect ID** and link a log/screenshot in **Evidence**.
4. Cells colour automatically: Pass = green, Fail = red, Blocked = orange, Not Run = neutral, Not Applicable = grey.

Dropdown-validated columns on Master: Execution Status, Priority, Test Type, Test Level, Automation Status.

---

## 3. How the dashboard updates

The **Test Execution Summary** KPIs are Excel formulas (`COUNTA`, `COUNTIF`, `COUNTIFS`, `IFERROR`) pointing at the Master status column (`$Q$5:$Q$110`). As soon as you change an **Execution Status** value, the counts, Pass %, Execution Progress %, by-module and by-priority tables, and both charts recompute.

- **Excel:** recalculates automatically (or press `F9`).
- **LibreOffice:** `Ctrl+Shift+F9` to force a full recalculation if needed.

If you add/remove test rows, re-run the generator so the formula ranges stay correct (see below).

---

## 4. Regenerating the workbook

The workbook is reproducible from the dataset. If `tc_data.py` changes:

```bash
# Use the venv that has openpyxl installed (workspace/backend/.venv)
workspace/backend/.venv/bin/python scripts/generate_test_cases.py
```

This overwrites `Cloudnaut_Support_Desk_Test_Cases.xlsx` at the repository root. It only reads `tc_data.py` and writes the workbook — it never touches application code.

If you don't have the venv, install the single dependency into any Python 3:

```bash
python3 -m pip install openpyxl
python3 scripts/generate_test_cases.py
```

---

## 5. Environment prerequisites

| Component | Detail |
|-----------|--------|
| Startup | `docker compose up --build` from the repo root |
| Frontend | http://localhost:3000 |
| Public API | http://localhost:4000 (health `/health`) |
| Internal backend | http://localhost:8001 (chat WebSocket published; otherwise internal only) |
| PostgreSQL | `localhost:5432`, db `cloudnaut_db`, user `cloudnaut` |
| MinIO | bucket `support-attachments` |
| Mailpit (SMTP) | SMTP `:1025`, UI http://localhost:8025 (for password-reset emails) |
| Redis | Optional — only for multi-instance chat fan-out (`REDIS_URL`) |
| `.env` | Set `AUTH_SECRET_KEY`, `POSTGRES_PASSWORD`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` (see `.env.example`) |

First admin: `python -m app.bootstrap_admin --name Admin --email admin@test.local` (run inside the backend container/venv). Create support/employee accounts via the admin UI or `POST /auth/signup` + admin approval.

**Safety:** run against a disposable dev stack only. The automated backend tests use in-memory SQLite + a mocked MinIO, so they do not touch the dev database or object store. Reset dev data with `docker compose down -v`. Never put real passwords, production secrets, or real user data in the workbook.

---

## 6. Coverage summary

- **106** executable test cases across **12** modules.
- **32** endpoints inventoried (public API + internal backend + chat WebSocket + health), each mapped in the Traceability sheet.
- Test types covered: Positive, Negative, Boundary, Authentication, Authorization, Business Logic, Database, Integration, Error Handling, Security, UI, E2E.
- Existing automated coverage is noted per test (Automation = `Automated`) where a matching Pytest exists under `workspace/backend/tests` or `workspace/api/tests`.

---

## 7. Known gaps, assumptions, and items needing review

**Verified-absent features** (listed on the Traceability sheet as `OOS-TC-*`, non-executable):
- No ticket **delete** endpoint.
- No free-text **search** endpoint (only filter/sort on `GET /requests`).
- No **pagination** params for ticket listing.
- No JWT **refresh/rotation** endpoint (stateless tokens, 8h expiry).
- No server-side **logout/token revocation** (logout clears client storage only).
- No MinIO **presigned URLs** (downloads are proxied through the API).

**Assumptions to confirm during execution (`Requires Clarification` where relevant):**
- WebSocket close codes are asserted as policy-violation (1008) based on `ws_auth`/`chat` router behaviour; confirm exact code with your WS client.
- Some validation errors surface as `422` at the public API (Pydantic) vs `400`/`409` at the backend; the workbook notes both where the tier matters.
- Charts render in Excel and LibreOffice; exact styling may differ slightly between the two.

**Verification performed:**
- Workbook opens in `openpyxl` and round-trips through LibreOffice Calc headless.
- Summary formulas recomputed by LibreOffice to Total `106`, Not Run `106`, all executed metrics `0` (correct honest baseline).
- Test Case IDs are unique (106 unique, 0 duplicates) and consistent across sheets.
