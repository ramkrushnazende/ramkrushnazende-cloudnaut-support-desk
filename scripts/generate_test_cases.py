"""
Generate Cloudnaut_Support_Desk_Test_Cases.xlsx at the repository root.

Run with the venv that has openpyxl:
    workspace/backend/.venv/bin/python scripts/generate_test_cases.py

This script only READS tc_data.py and WRITES the workbook + README.
It does not touch application source.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import tc_data as D  # noqa: E402

from openpyxl import Workbook  # noqa: E402
from openpyxl.chart import BarChart, PieChart, Reference  # noqa: E402
from openpyxl.styles import (  # noqa: E402
    Alignment, Border, Font, PatternFill, Side,
)
from openpyxl.utils import get_column_letter  # noqa: E402
from openpyxl.worksheet.datavalidation import DataValidation  # noqa: E402
from openpyxl.formatting.rule import CellIsRule  # noqa: E402

OUT_XLSX = os.path.join(ROOT, "Cloudnaut_Support_Desk_Test_Cases.xlsx")

# ---- palette ----
NAVY = "0F2340"
BLUE = "2563EB"
CYAN = "0891B2"
LIGHT = "EAF1FB"
STRIPE = "F3F7FC"
GREEN = "C6EFCE"
GREEN_T = "006100"
RED = "FFC7CE"
RED_T = "9C0006"
ORANGE = "FFEB9C"
ORANGE_T = "9C6500"
GREY = "D9D9D9"
GREY_T = "3F3F3F"

HEADER_FILL = PatternFill("solid", fgColor=NAVY)
HEADER_FONT = Font(bold=True, color="FFFFFF", size=11)
TITLE_FONT = Font(bold=True, color=NAVY, size=16)
SUB_FONT = Font(bold=True, color=BLUE, size=12)
WRAP_TOP = Alignment(wrap_text=True, vertical="top")
CENTER = Alignment(horizontal="center", vertical="center")
LEFT_TOP = Alignment(horizontal="left", vertical="top", wrap_text=True)
THIN = Side(style="thin", color="C9D4E3")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)


def style_header(ws, row, ncols):
    for c in range(1, ncols + 1):
        cell = ws.cell(row=row, column=c)
        cell.fill = HEADER_FILL
        cell.font = HEADER_FONT
        cell.alignment = Alignment(wrap_text=True, vertical="center", horizontal="center")
        cell.border = BORDER


def stripe_and_border(ws, first_data_row, last_row, ncols):
    for r in range(first_data_row, last_row + 1):
        fill = PatternFill("solid", fgColor=STRIPE) if (r - first_data_row) % 2 else None
        for c in range(1, ncols + 1):
            cell = ws.cell(row=r, column=c)
            cell.border = BORDER
            if fill and cell.fill.fgColor.rgb in (None, "00000000"):
                cell.fill = fill
            if cell.alignment.wrap_text is not True:
                cell.alignment = WRAP_TOP


def set_widths(ws, widths):
    for col, w in widths.items():
        ws.column_dimensions[col].width = w


# ===========================================================================
# SHEET 2: MASTER TEST CASES  (built first so summary can reference it)
# ===========================================================================
MASTER_COLS = [
    ("Test Case ID", 14), ("Module", 16), ("Feature", 18), ("API / Endpoint", 30),
    ("Test Scenario", 26), ("Test Case Description", 40), ("Preconditions", 26),
    ("Test Data", 26), ("Execution Steps", 46), ("Expected Result", 46),
    ("Actual Result", 24), ("HTTP Status Code Expected", 14),
    ("HTTP Status Code Actual", 14), ("Priority (P0/P1/P2/P3)", 10),
    ("Test Type", 16), ("Test Level", 12),
    ("Execution Status", 16), ("Defect ID", 12),
    ("Evidence / Screenshot / Log", 22), ("Automation Status", 14),
    ("Source File / Function", 44), ("Remarks", 30),
]

STATUS_LIST = '"Not Run,Pass,Fail,Blocked,Not Applicable"'
PRIO_LIST = '"P0,P1,P2,P3"'
TTYPE_LIST = ('"Positive,Negative,Boundary,Authentication,Authorization,'
              'Business Logic,Database,Integration,Error Handling,Security,'
              'Regression,UI,E2E"')
LEVEL_LIST = '"Unit,Integration,API,UI,E2E"'
AUTO_LIST = '"Manual,Automated,Planned"'


def row_from_tc(t):
    return [
        t["id"], t["module"], t["feature"], t["endpoint"], t["scenario"],
        t["desc"], t["pre"], t["data"], t["steps"], t["expected"], "",  # actual
        t["http_exp"], "",  # http actual
        t["prio"], t["ttype"], t["level"], "Not Run", "", "", t["automation"],
        t["src"], t["remarks"],
    ]


def build_master(wb, all_tcs):
    ws = wb.create_sheet("Master Test Cases")
    ws.cell(row=1, column=1, value="Master Test Cases").font = TITLE_FONT
    ws.cell(row=2, column=1,
            value="One row per test case. Leave Actual Result / HTTP Actual / Execution Status "
                  "until the test is genuinely executed. Status defaults to 'Not Run'.").font = \
        Font(italic=True, color=GREY_T, size=9)
    header_row = 4
    for i, (name, _) in enumerate(MASTER_COLS, start=1):
        ws.cell(row=header_row, column=i, value=name)
    style_header(ws, header_row, len(MASTER_COLS))

    r = header_row + 1
    for t in all_tcs:
        for i, val in enumerate(row_from_tc(t), start=1):
            ws.cell(row=r, column=i, value=val)
        r += 1
    last = r - 1

    set_widths(ws, {get_column_letter(i): w for i, (_, w) in enumerate(MASTER_COLS, start=1)})
    stripe_and_border(ws, header_row + 1, last, len(MASTER_COLS))
    ws.freeze_panes = ws.cell(row=header_row + 1, column=5)
    ws.auto_filter.ref = f"A{header_row}:{get_column_letter(len(MASTER_COLS))}{last}"

    # dropdowns
    def add_dv(formula, col_letter):
        dv = DataValidation(type="list", formula1=formula, allow_blank=True)
        dv.add(f"{col_letter}{header_row+1}:{col_letter}{last}")
        ws.add_data_validation(dv)

    add_dv(STATUS_LIST, "Q")   # Execution Status
    add_dv(PRIO_LIST, "N")     # Priority
    add_dv(TTYPE_LIST, "O")    # Test Type
    add_dv(LEVEL_LIST, "P")    # Test Level
    add_dv(AUTO_LIST, "T")     # Automation Status

    # conditional formatting on Execution Status column (Q)
    rng = f"Q{header_row+1}:Q{last}"
    ws.conditional_formatting.add(rng, CellIsRule(operator="equal", formula=['"Pass"'],
                                  fill=PatternFill("solid", fgColor=GREEN), font=Font(color=GREEN_T)))
    ws.conditional_formatting.add(rng, CellIsRule(operator="equal", formula=['"Fail"'],
                                  fill=PatternFill("solid", fgColor=RED), font=Font(color=RED_T)))
    ws.conditional_formatting.add(rng, CellIsRule(operator="equal", formula=['"Blocked"'],
                                  fill=PatternFill("solid", fgColor=ORANGE), font=Font(color=ORANGE_T)))
    ws.conditional_formatting.add(rng, CellIsRule(operator="equal", formula=['"Not Run"'],
                                  fill=PatternFill("solid", fgColor="FFFFFF"), font=Font(color=GREY_T)))
    ws.conditional_formatting.add(rng, CellIsRule(operator="equal", formula=['"Not Applicable"'],
                                  fill=PatternFill("solid", fgColor=GREY), font=Font(color=GREY_T)))
    return ws, header_row, last


# ===========================================================================
# SHEET 1: TEST EXECUTION SUMMARY (dashboard)
# ===========================================================================
def build_summary(wb, master_ws, hr, last, modules, priorities):
    ws = wb.create_sheet("Test Execution Summary")
    ws.sheet_view.showGridLines = False
    ws.cell(row=1, column=1, value="Cloudnaut Support Desk — Test Execution Summary").font = TITLE_FONT
    ws.cell(row=2, column=1, value="Metrics auto-update from the 'Master Test Cases' sheet.").font = \
        Font(italic=True, color=GREY_T, size=9)

    mref = "'Master Test Cases'"
    status_col = f"{mref}!$Q${hr+1}:$Q${last}"
    total_formula = f"COUNTA({mref}!$A${hr+1}:$A${last})"

    # KPI block
    ws.cell(row=4, column=1, value="Metric").font = HEADER_FONT
    ws.cell(row=4, column=2, value="Value").font = HEADER_FONT
    for c in (1, 2):
        ws.cell(row=4, column=c).fill = HEADER_FILL
        ws.cell(row=4, column=c).alignment = CENTER
    kpis = [
        ("Total Test Cases", f"={total_formula}"),
        ("Not Run", f'=COUNTIF({status_col},"Not Run")'),
        ("Pass", f'=COUNTIF({status_col},"Pass")'),
        ("Fail", f'=COUNTIF({status_col},"Fail")'),
        ("Blocked", f'=COUNTIF({status_col},"Blocked")'),
        ("Not Applicable", f'=COUNTIF({status_col},"Not Applicable")'),
        ("Executed (Pass+Fail)", f'=COUNTIF({status_col},"Pass")+COUNTIF({status_col},"Fail")'),
        ("Pass %", f'=IFERROR(COUNTIF({status_col},"Pass")/(COUNTIF({status_col},"Pass")+COUNTIF({status_col},"Fail")),0)'),
        ("Execution Progress %", f'=IFERROR((B5-B6)/B5,0)'),  # (total - notrun)/total  (approx; see note)
    ]
    # Fix execution progress to reference KPI rows precisely below.
    row = 5
    for name, formula in kpis:
        ws.cell(row=row, column=1, value=name)
        ws.cell(row=row, column=2, value=formula)
        row += 1
    # Correct the Execution Progress % formula to (Total - Not Run)/Total
    ws["B13"] = "=IFERROR((B5-B6)/B5,0)"
    ws["B12"].number_format = "0.0%"
    ws["B13"].number_format = "0.0%"
    for r in range(5, 14):
        ws.cell(row=r, column=1).border = BORDER
        ws.cell(row=r, column=2).border = BORDER
        ws.cell(row=r, column=1).alignment = Alignment(vertical="center")
        ws.cell(row=r, column=2).alignment = CENTER

    # By module table
    base = 16
    ws.cell(row=base - 1, column=1, value="Test Cases by Module").font = SUB_FONT
    ws.cell(row=base, column=1, value="Module").font = HEADER_FONT
    ws.cell(row=base, column=2, value="Total").font = HEADER_FONT
    ws.cell(row=base, column=3, value="Pass").font = HEADER_FONT
    ws.cell(row=base, column=4, value="Fail").font = HEADER_FONT
    for c in range(1, 5):
        ws.cell(row=base, column=c).fill = HEADER_FILL
        ws.cell(row=base, column=c).alignment = CENTER
    mod_col = f"{mref}!$B${hr+1}:$B${last}"
    r = base + 1
    for m in modules:
        ws.cell(row=r, column=1, value=m)
        ws.cell(row=r, column=2, value=f'=COUNTIF({mod_col},A{r})')
        ws.cell(row=r, column=3,
                value=f'=COUNTIFS({mod_col},A{r},{status_col},"Pass")')
        ws.cell(row=r, column=4,
                value=f'=COUNTIFS({mod_col},A{r},{status_col},"Fail")')
        for c in range(1, 5):
            ws.cell(row=r, column=c).border = BORDER
        r += 1
    module_last = r - 1

    # By priority table
    pbase = module_last + 3
    ws.cell(row=pbase - 1, column=1, value="Test Cases by Priority").font = SUB_FONT
    ws.cell(row=pbase, column=1, value="Priority").font = HEADER_FONT
    ws.cell(row=pbase, column=2, value="Count").font = HEADER_FONT
    for c in (1, 2):
        ws.cell(row=pbase, column=c).fill = HEADER_FILL
        ws.cell(row=pbase, column=c).alignment = CENTER
    prio_col = f"{mref}!$N${hr+1}:$N${last}"
    r = pbase + 1
    for p in priorities:
        ws.cell(row=r, column=1, value=p)
        ws.cell(row=r, column=2, value=f'=COUNTIF({prio_col},A{r})')
        ws.cell(row=r, column=1).border = BORDER
        ws.cell(row=r, column=2).border = BORDER
        r += 1
    prio_last = r - 1

    set_widths(ws, {"A": 30, "B": 16, "C": 10, "D": 10})

    # Charts
    pie = PieChart()
    pie.title = "Execution Status Distribution"
    labels = Reference(ws, min_col=1, min_row=6, max_row=9)  # Not Run..Blocked
    data = Reference(ws, min_col=2, min_row=5, max_row=9)
    pie.add_data(data, titles_from_data=False)
    pie.set_categories(Reference(ws, min_col=1, min_row=5, max_row=9))
    pie.height = 7.5
    pie.width = 12
    ws.add_chart(pie, "F4")

    bar = BarChart()
    bar.type = "col"
    bar.title = "Test Cases by Module"
    bar.y_axis.title = "Count"
    cats = Reference(ws, min_col=1, min_row=base + 1, max_row=module_last)
    vals = Reference(ws, min_col=2, min_row=base, max_row=module_last)
    bar.add_data(vals, titles_from_data=True)
    bar.set_categories(cats)
    bar.height = 8
    bar.width = 16
    ws.add_chart(bar, "F20")

    return ws


# ===========================================================================
# SHEET 3: API TEST CASES
# ===========================================================================
def build_api(wb):
    ws = wb.create_sheet("API Test Cases")
    ws.cell(row=1, column=1, value="API Endpoint Inventory (Public API :4000  →  Internal Backend :8001)").font = TITLE_FONT
    cols = ["Method", "Public Endpoint", "Internal Backend Endpoint", "Auth",
            "Allowed Roles", "Notes / Rules", "Related Test Case IDs"]
    hr = 3
    for i, name in enumerate(cols, 1):
        ws.cell(row=hr, column=i, value=name)
    style_header(ws, hr, len(cols))

    # crude mapping endpoint->tc ids by matching endpoint substring
    def related(pubpath):
        ids = []
        key = pubpath.split("{")[0].rstrip("/")
        for t in D.TEST_CASES:
            if key and key in t["endpoint"]:
                ids.append(t["id"])
        return ", ".join(ids[:8])

    r = hr + 1
    for (method, pub, backend, auth, roles, notes) in D.ENDPOINTS:
        ws.cell(row=r, column=1, value=method)
        ws.cell(row=r, column=2, value=pub)
        ws.cell(row=r, column=3, value=backend)
        ws.cell(row=r, column=4, value=auth)
        ws.cell(row=r, column=5, value=roles)
        ws.cell(row=r, column=6, value=notes)
        ws.cell(row=r, column=7, value=related(pub))
        r += 1
    last = r - 1
    set_widths(ws, {"A": 8, "B": 34, "C": 40, "D": 14, "E": 26, "F": 46, "G": 30})
    stripe_and_border(ws, hr + 1, last, len(cols))
    ws.freeze_panes = ws.cell(row=hr + 1, column=1)
    ws.auto_filter.ref = f"A{hr}:G{last}"
    return ws


# ===========================================================================
# SHEET 4: AUTH & RBAC (permission matrix)
# ===========================================================================
def build_rbac(wb):
    ws = wb.create_sheet("Authentication and RBAC")
    ws.cell(row=1, column=1, value="Authentication & RBAC — Permission Matrix (from code)").font = TITLE_FONT
    ws.cell(row=2, column=1, value="Y = allowed, N = forbidden (403), Own = allowed only for the user's own ticket.").font = \
        Font(italic=True, color=GREY_T, size=9)

    actions = [
        ("Login / Logout", "Y", "Y", "Y"),
        ("Create ticket", "Own", "Y", "Y"),
        ("List tickets", "Own", "Y", "Y"),
        ("View ticket detail", "Own", "Y", "Y"),
        ("Edit ticket fields", "N", "Y", "Y"),
        ("Assign ticket", "N", "Y", "Y"),
        ("Change status", "N", "Y", "Y"),
        ("Add note (internal/public)", "N", "Y", "Y"),
        ("View notes", "Own/public-only", "Y", "Y"),
        ("View history", "N", "Y", "Y"),
        ("Progress updates feed", "Y (own)", "N", "N"),
        ("Dashboard summary", "N", "Y", "Y"),
        ("Upload/list/download/delete attachment", "Own", "Y", "Y"),
        ("Open/view chat", "Own", "Y", "Y"),
        ("Send chat message", "Own", "Y", "Y"),
        ("Close/reopen chat", "N", "Y", "Y"),
        ("List team members", "N", "Y", "Y"),
        ("Create team member", "N", "N", "Y"),
        ("Update team member", "N", "N", "Y"),
        ("Review access requests", "N", "N", "Y"),
    ]
    hr = 4
    for i, name in enumerate(["Action / Capability", "employee", "support", "admin"], 1):
        ws.cell(row=hr, column=i, value=name)
    style_header(ws, hr, 4)
    r = hr + 1
    for a in actions:
        for i, v in enumerate(a, 1):
            ws.cell(row=r, column=i, value=v)
        r += 1
    last = r - 1
    set_widths(ws, {"A": 42, "B": 20, "C": 14, "D": 14})
    stripe_and_border(ws, hr + 1, last, 4)
    ws.freeze_panes = ws.cell(row=hr + 1, column=1)

    # token/jwt facts
    fb = last + 3
    ws.cell(row=fb - 1, column=1, value="Authentication / JWT facts (verified)").font = SUB_FONT
    ws.cell(row=fb, column=1, value="Fact").font = HEADER_FONT
    ws.cell(row=fb, column=2, value="Source").font = HEADER_FONT
    ws.cell(row=fb, column=3, value="Detail").font = HEADER_FONT
    for c in range(1, 4):
        ws.cell(row=fb, column=c).fill = HEADER_FILL
    r = fb + 1
    for (fact, src, detail) in D.CONFIG_FACTS:
        if any(k in fact for k in ("JWT", "Token", "Password", "AUTH")):
            ws.cell(row=r, column=1, value=fact)
            ws.cell(row=r, column=2, value=src)
            ws.cell(row=r, column=3, value=detail)
            for c in range(1, 4):
                ws.cell(row=r, column=c).border = BORDER
                ws.cell(row=r, column=c).alignment = WRAP_TOP
            r += 1
    ws.column_dimensions["C"].width = 60

    # Auth/RBAC/Password test-case rows
    tb = r + 2
    ws.cell(row=tb - 1, column=1, value="Authentication / Authorization / Password Test Cases").font = SUB_FONT
    tc_cols = ["Test Case ID", "Scenario", "Endpoint", "Expected Result",
               "HTTP Exp", "Priority", "Execution Status", "Source"]
    for i, name in enumerate(tc_cols, 1):
        ws.cell(row=tb, column=i, value=name)
    style_header(ws, tb, len(tc_cols))
    rr = tb + 1
    auth_mods = {"Authentication", "Authorization"}
    auth_rows = [t for t in D.TEST_CASES
                 if t["module"] in auth_mods or t["id"].startswith(("AUTH", "RBAC", "PWD"))]
    for t in auth_rows:
        vals = [t["id"], t["scenario"], t["endpoint"], t["expected"],
                t["http_exp"], t["prio"], "Not Run", t["src"]]
        for i, v in enumerate(vals, 1):
            ws.cell(row=rr, column=i, value=v)
            ws.cell(row=rr, column=i).border = BORDER
            ws.cell(row=rr, column=i).alignment = WRAP_TOP
        rr += 1
    auth_last = rr - 1
    # widen for TC table
    set_widths(ws, {"A": 42, "B": 26, "C": 22, "D": 46, "E": 10,
                    "F": 9, "G": 16, "H": 40})
    dv = DataValidation(type="list", formula1=STATUS_LIST, allow_blank=True)
    dv.add(f"G{tb+1}:G{auth_last}")
    ws.add_data_validation(dv)
    grng = f"G{tb+1}:G{auth_last}"
    ws.conditional_formatting.add(grng, CellIsRule(operator="equal", formula=['"Pass"'],
                                  fill=PatternFill("solid", fgColor=GREEN), font=Font(color=GREEN_T)))
    ws.conditional_formatting.add(grng, CellIsRule(operator="equal", formula=['"Fail"'],
                                  fill=PatternFill("solid", fgColor=RED), font=Font(color=RED_T)))
    ws.conditional_formatting.add(grng, CellIsRule(operator="equal", formula=['"Blocked"'],
                                  fill=PatternFill("solid", fgColor=ORANGE), font=Font(color=ORANGE_T)))
    return ws


# ===========================================================================
# Generic filtered-TC sheet builder (Lifecycle / Attachments / DB / UI)
# ===========================================================================
TC_SHEET_COLS = [
    ("Test Case ID", 14), ("Feature", 20), ("API / Endpoint", 30),
    ("Test Scenario", 26), ("Execution Steps", 46), ("Expected Result", 46),
    ("HTTP Exp", 10), ("Priority", 9), ("Test Type", 16),
    ("Execution Status", 16), ("Source File / Function", 40), ("Remarks", 28),
]


def build_tc_sheet(wb, title, predicate, intro):
    ws = wb.create_sheet(title)
    ws.cell(row=1, column=1, value=title).font = TITLE_FONT
    ws.cell(row=2, column=1, value=intro).font = Font(italic=True, color=GREY_T, size=9)
    hr = 4
    for i, (name, _) in enumerate(TC_SHEET_COLS, 1):
        ws.cell(row=hr, column=i, value=name)
    style_header(ws, hr, len(TC_SHEET_COLS))
    r = hr + 1
    rows = [t for t in D.TEST_CASES if predicate(t)]
    for t in rows:
        vals = [t["id"], t["feature"], t["endpoint"], t["scenario"], t["steps"],
                t["expected"], t["http_exp"], t["prio"], t["ttype"], "Not Run",
                t["src"], t["remarks"]]
        for i, v in enumerate(vals, 1):
            ws.cell(row=r, column=i, value=v)
        r += 1
    last = max(r - 1, hr + 1)
    set_widths(ws, {get_column_letter(i): w for i, (_, w) in enumerate(TC_SHEET_COLS, 1)})
    stripe_and_border(ws, hr + 1, last, len(TC_SHEET_COLS))
    ws.freeze_panes = ws.cell(row=hr + 1, column=1)
    ws.auto_filter.ref = f"A{hr}:{get_column_letter(len(TC_SHEET_COLS))}{last}"
    # status dropdown + CF
    dv = DataValidation(type="list", formula1=STATUS_LIST, allow_blank=True)
    dv.add(f"J{hr+1}:J{last}")
    ws.add_data_validation(dv)
    rng = f"J{hr+1}:J{last}"
    ws.conditional_formatting.add(rng, CellIsRule(operator="equal", formula=['"Pass"'],
                                  fill=PatternFill("solid", fgColor=GREEN), font=Font(color=GREEN_T)))
    ws.conditional_formatting.add(rng, CellIsRule(operator="equal", formula=['"Fail"'],
                                  fill=PatternFill("solid", fgColor=RED), font=Font(color=RED_T)))
    ws.conditional_formatting.add(rng, CellIsRule(operator="equal", formula=['"Blocked"'],
                                  fill=PatternFill("solid", fgColor=ORANGE), font=Font(color=ORANGE_T)))
    return ws, len(rows)


# ===========================================================================
# SHEET 9: TEST DATA & ENVIRONMENT
# ===========================================================================
def build_env(wb):
    ws = wb.create_sheet("Test Data and Environment")
    ws.cell(row=1, column=1, value="Test Data & Environment").font = TITLE_FONT
    ws.cell(row=2, column=1,
            value="Use throwaway accounts only. Never enter real passwords, production secrets, or real user data.").font = \
        Font(italic=True, color=RED_T, size=9)

    # accounts
    ws.cell(row=4, column=1, value="Suggested Test Accounts (create via bootstrap_admin + admin UI)").font = SUB_FONT
    acc_hdr = 5
    for i, name in enumerate(["Role", "Example Email", "Password Rule", "How to create"], 1):
        ws.cell(row=acc_hdr, column=i, value=name)
    style_header(ws, acc_hdr, 4)
    accounts = [
        ("admin", "admin@test.local", ">=12 chars", "python -m app.bootstrap_admin --name Admin --email admin@test.local"),
        ("support", "support@test.local", ">=12 chars + upper/lower/digit/symbol", "Public Cognito signup, email confirmation, then Admin approval"),
        ("employee", "employee@test.local", ">=12 chars + upper/lower/digit/symbol", "Public Cognito signup, email confirmation, then Admin approval"),
        ("employee2", "employee2@test.local", ">=12 chars + upper/lower/digit/symbol", "Second verified Cognito account for cross-user/ownership tests"),
    ]
    r = acc_hdr + 1
    for a in accounts:
        for i, v in enumerate(a, 1):
            ws.cell(row=r, column=i, value=v)
            ws.cell(row=r, column=i).border = BORDER
            ws.cell(row=r, column=i).alignment = WRAP_TOP
        r += 1

    # env prerequisites
    eb = r + 2
    ws.cell(row=eb - 1, column=1, value="Environment Prerequisites").font = SUB_FONT
    for i, name in enumerate(["Component", "Detail"], 1):
        ws.cell(row=eb, column=i, value=name)
    style_header(ws, eb, 2)
    env = [
        ("Startup", "docker compose up --build (from repo root)"),
        ("Frontend", "http://localhost:3000"),
        ("Public API", "http://localhost:4000 (health: /health)"),
        ("Internal backend", "http://localhost:8001 (chat WS published; otherwise internal)"),
        ("PostgreSQL", "localhost:5432 db=cloudnaut_db user=cloudnaut"),
        ("MinIO", "bucket support-attachments (console :9001 inside compose)"),
        ("Mailpit (SMTP)", "SMTP :1025, UI http://localhost:8025 for reset emails"),
        ("Redis", "Optional; only for multi-instance chat (REDIS_URL)"),
        (".env", "Set AUTH_SECRET_KEY, POSTGRES_PASSWORD, MINIO_ROOT_USER/PASSWORD (see .env.example)"),
    ]
    r = eb + 1
    for a in env:
        for i, v in enumerate(a, 1):
            ws.cell(row=r, column=i, value=v)
            ws.cell(row=r, column=i).border = BORDER
            ws.cell(row=r, column=i).alignment = WRAP_TOP
        r += 1

    # sample payloads
    pb = r + 2
    ws.cell(row=pb - 1, column=1, value="Sample Safe Payloads").font = SUB_FONT
    for i, name in enumerate(["Purpose", "JSON"], 1):
        ws.cell(row=pb, column=i, value=name)
    style_header(ws, pb, 2)
    payloads = [
        ("Login", '{"email":"admin@test.local","password":"<local-test-pass>"}'),
        ("Create ticket", '{"title":"Printer offline","description":"3rd floor printer unreachable","requester_name":"Emp One","requester_email":"employee@test.local","category":"Infrastructure","priority":"Medium"}'),
        ("Change status", '{"status":"In Progress"}'),
        ("Add public note", '{"note":"Investigating now","created_by":"Support","is_public":true}'),
        ("Chat message", '{"body":"Hello, any update?"}'),
        ("Signup", '{"name":"Emp Two","email":"employee2@test.local","password":"<local-test-pass>","role":"employee"}'),
    ]
    r = pb + 1
    for a in payloads:
        for i, v in enumerate(a, 1):
            ws.cell(row=r, column=i, value=v)
            ws.cell(row=r, column=i).border = BORDER
            ws.cell(row=r, column=i).alignment = WRAP_TOP
        r += 1

    # cleanup
    cb = r + 2
    ws.cell(row=cb - 1, column=1, value="Cleanup / Safety").font = SUB_FONT
    notes = [
        "Run tests against a disposable dev stack, never production.",
        "Automated backend tests use in-memory SQLite + mocked MinIO; they do not touch the dev DB.",
        "To reset dev data: docker compose down -v (drops pgdata + minio_data volumes).",
        "Do not commit real secrets; keep .env out of version control.",
    ]
    r = cb
    for n in notes:
        ws.cell(row=r, column=1, value="• " + n)
        r += 1

    set_widths(ws, {"A": 30, "B": 70, "C": 20, "D": 60})
    return ws


# ===========================================================================
# SHEET 10: REQUIREMENTS TRACEABILITY
# ===========================================================================
def build_trace(wb):
    ws = wb.create_sheet("Requirements Traceability")
    ws.cell(row=1, column=1, value="Requirements Traceability — Module/Endpoint → Test Cases").font = TITLE_FONT
    hr = 3
    cols = ["Module", "Endpoint / Capability", "Source File", "Test Case IDs", "Coverage"]
    for i, name in enumerate(cols, 1):
        ws.cell(row=hr, column=i, value=name)
    style_header(ws, hr, len(cols))

    r = hr + 1
    for (method, pub, backend, auth, roles, notes) in D.ENDPOINTS:
        key = pub.split("{")[0].rstrip("/")
        ids = [t["id"] for t in D.TEST_CASES if key and key in t["endpoint"]]
        src = ""
        # best-effort source hint
        if "/auth" in pub or "login" in pub:
            src = "backend/app/main.py; api/routers/requests.py"
        elif "attachments" in pub:
            src = "api/routers/attachments.py; backend/app/routers/attachments.py; attachment_service.py"
        elif "chat" in pub:
            src = "api/routers/chat.py; backend/app/routers/chat.py; chat_service.py"
        elif "team-members" in pub or "access-requests" in pub:
            src = "backend/app/main.py; api/routers/requests.py (team_router)"
        elif "dashboard" in pub:
            src = "backend/app/main.py:get_dashboard"
        elif "requests" in pub:
            src = "api/routers/requests.py; backend/app/main.py; request_service.py; request_repository.py"
        else:
            src = "api/app.py; backend/app/main.py"
        cov = "Covered" if ids else "GAP - no explicit TC"
        ws.cell(row=r, column=1, value=f"{method} {pub.split('?')[0]}")
        ws.cell(row=r, column=2, value=notes)
        ws.cell(row=r, column=3, value=src)
        ws.cell(row=r, column=4, value=", ".join(ids))
        ws.cell(row=r, column=5, value=cov)
        r += 1
    last = r - 1
    set_widths(ws, {"A": 34, "B": 44, "C": 50, "D": 34, "E": 18})
    stripe_and_border(ws, hr + 1, last, len(cols))
    ws.freeze_panes = ws.cell(row=hr + 1, column=1)
    ws.auto_filter.ref = f"A{hr}:E{last}"

    # Out-of-scope block
    ob = last + 3
    ws.cell(row=ob - 1, column=1, value="Not Implemented / Out of Scope (proposed, non-executable)").font = SUB_FONT
    for i, name in enumerate(["Proposed TC ID", "Capability", "Why out of scope"], 1):
        ws.cell(row=ob, column=i, value=name)
    style_header(ws, ob, 3)
    r = ob + 1
    for t in D.OUT_OF_SCOPE:
        ws.cell(row=r, column=1, value=t["id"])
        ws.cell(row=r, column=2, value=f'{t["feature"]} ({t["scenario"]})')
        ws.cell(row=r, column=3, value=t["desc"])
        for c in range(1, 4):
            ws.cell(row=r, column=c).border = BORDER
            ws.cell(row=r, column=c).alignment = WRAP_TOP
        r += 1
    return ws


# ===========================================================================
# MAIN
# ===========================================================================
def main():
    all_tcs = list(D.TEST_CASES)  # executable only in Master
    modules = sorted({t["module"] for t in all_tcs})
    priorities = ["P0", "P1", "P2", "P3"]

    wb = Workbook()
    wb.remove(wb.active)  # drop default sheet; we create in desired order

    # Build master first (needed for summary formulas), then move to position 2.
    master_ws, hr, last = build_master(wb, all_tcs)
    summary_ws = build_summary(wb, master_ws, hr, last, modules, priorities)
    api_ws = build_api(wb)
    rbac_ws = build_rbac(wb)
    life_ws, n_life = build_tc_sheet(
        wb, "Request Lifecycle",
        lambda t: t["module"] in ("Request Lifecycle", "Team Management", "Access Requests"),
        "Create, list, get, update, assign, status, notes, history, team & access-request flows.")
    att_ws, n_att = build_tc_sheet(
        wb, "Attachments and MinIO",
        lambda t: t["module"] == "Attachments",
        "Upload/download/delete, validation, size/type limits, ownership, and MinIO resilience.")
    db_ws, n_db = build_tc_sheet(
        wb, "Database and Integration",
        lambda t: t["module"] in ("Database", "Integration"),
        "Persistence, constraints, migrations, API↔backend integration and error propagation. "
        "Do not run destructive deletes against a shared dev DB.")
    ui_ws, n_ui = build_tc_sheet(
        wb, "UI and End-to-End Tests",
        lambda t: t["module"] in ("Frontend", "End-to-End", "Live Chat", "Infrastructure"),
        "Frontend forms/validation/states, live chat, health checks, and full user journeys. "
        "Only features present in the system.")

    env_ws = build_env(wb)
    trace_ws = build_trace(wb)

    # Reorder to required sheet order
    order = [
        "Test Execution Summary", "Master Test Cases", "API Test Cases",
        "Authentication and RBAC", "Request Lifecycle", "Attachments and MinIO",
        "Database and Integration", "UI and End-to-End Tests",
        "Test Data and Environment", "Requirements Traceability",
    ]
    wb._sheets.sort(key=lambda s: order.index(s.title) if s.title in order else 99)
    wb.active = 0

    wb.save(OUT_XLSX)

    print("WORKBOOK:", OUT_XLSX)
    print("Executable test cases:", len(all_tcs))
    print("Out-of-scope proposals:", len(D.OUT_OF_SCOPE))
    print("Endpoints inventoried:", len(D.ENDPOINTS))
    print("Modules:", ", ".join(modules))
    print("Sheets:", ", ".join(s.title for s in wb._sheets))


if __name__ == "__main__":
    main()
