"""Rebuild the HWR person-month allocation workbook (v8 -> v9).

Reads `euroFMX_HWR_PM_v8.xlsx` and rewrites ONE row — row 71, the WP2 monthly
allocation — so that WP2 draws the full capacity left after WP4 in the months
before WP8 opens (M1-M15).  Without this, 0.55 PM of contracted capacity went
unused in M12-M15 (May-Aug 2027), because WP4 and WP2 were each capped at their
even-burn rate and WP8 (T8.6/T8.7) does not start until M16.

Run with python3.13 — `python3` is 3.11 in this environment and has no openpyxl:

    python3.13 build_pm_sheet.py

then recalculate, because openpyxl writes formulas as text and caches no values:

    soffice --headless --norestore --convert-to xlsx --outdir out euroFMX_HWR_PM_v9.xlsx

Cell references used below (see docs/projects/eurofmx-hwr.md §6 for the full row map):
  row 62  project month 1..48          row 68  capacity left after WP4
  row 64  monthly capacity (PM)        row 71  WP2 allocation   <- rewritten here
  row 66  WP2 even-burn required rate  row 79  cumulative WP2
  $E$42 WP2 approved PM (6.00) · $F$42/$G$42 WP2 window (M1-M33) · $F$45 WP8 start (M16)
"""

import openpyxl
from openpyxl.utils import get_column_letter as gl

SRC = 'euroFMX_HWR_PM_v8.xlsx'
DST = 'euroFMX_HWR_PM_v9.xlsx'

wb = openpyxl.load_workbook(SRC)
ws = wb[wb.sheetnames[0]]

n = 0
for c in range(3, 51):                     # columns C..AX = project months M1..M48
    L = gl(c)                              # this month
    P = gl(c - 1)                          # previous month (cumulative lookback)
    ws[f'{L}71'] = (
        # only inside WP2's own schedule window
        f'=IF(AND({L}$62>=$F$42,{L}$62<=$G$42),'
        # before WP8 opens take everything left after WP4, capped by WP2's remainder;
        # from M16 fall back to the even-burn rate, which recomputes over what is left
        f'MIN({L}68,IF({L}$62<$F$45,MAX(0,$E$42-{P}79),{L}66)),0)'
    )
    n += 1

wb.save(DST)
print('rewrote', n, 'cells in row 71 ->', DST)
