#!/usr/bin/env python3
"""Export TSLA daily close price & volume to Excel with chart."""

import json
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from openpyxl import Workbook
from openpyxl.chart import BarChart, LineChart, Reference
from openpyxl.chart.series import DataPoint
from openpyxl.styles import Font, Alignment, PatternFill, Border, Side, numbers
from openpyxl.utils import get_column_letter

# ── Config ──────────────────────────────────────────────────────────────
SYMBOL = "TSLA"
START_DATE = datetime(2020, 1, 1, tzinfo=timezone.utc)
OUTPUT_DIR = Path(__file__).resolve().parent.parent / "exports"
OUTPUT_FILE = OUTPUT_DIR / f"{SYMBOL}_Volume_{START_DATE.strftime('%Y')}_Present.xlsx"

# ── Fetch from Yahoo Finance ────────────────────────────────────────────
period1 = int(START_DATE.timestamp())
period2 = int(datetime.now(timezone.utc).timestamp())
url = (
    f"https://query1.finance.yahoo.com/v8/finance/chart/{SYMBOL}"
    f"?period1={period1}&period2={period2}&interval=1d&includePrePost=false"
)

print(f"Fetching {SYMBOL} daily data from {START_DATE.strftime('%Y-%m-%d')} to today...")

req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
with urllib.request.urlopen(req) as resp:
    data = json.loads(resp.read().decode())

result = data["chart"]["result"][0]
timestamps = result["timestamp"]
quotes = result["indicators"]["quote"][0]
closes = quotes["close"]
volumes = quotes["volume"]

# Build rows: (date, close, volume)
rows = []
for ts, close, vol in zip(timestamps, closes, volumes):
    if close is None or vol is None:
        continue
    dt = datetime.fromtimestamp(ts, tz=timezone.utc)
    rows.append((dt.strftime("%Y-%m-%d"), round(close, 2), vol))

print(f"Got {len(rows)} trading days")

# ── Styles ──────────────────────────────────────────────────────────────
HEADER_FONT = Font(name="IBM Plex Mono", bold=True, color="FFFFFF", size=11)
HEADER_FILL = PatternFill(start_color="1a1a2e", end_color="1a1a2e", fill_type="solid")
DATA_FONT = Font(name="IBM Plex Mono", size=10)
THIN_BORDER = Border(
    bottom=Side(style="thin", color="333333"),
    right=Side(style="thin", color="DDDDDD"),
)

# ── Workbook ────────────────────────────────────────────────────────────
wb = Workbook()

# ── Sheet 1: Data ───────────────────────────────────────────────────────
ws_data = wb.active
ws_data.title = "Data"
ws_data.sheet_properties.tabColor = "1a1a2e"

headers = ["Date", "Close ($)", "Volume"]
for col, header in enumerate(headers, 1):
    cell = ws_data.cell(row=1, column=col, value=header)
    cell.font = HEADER_FONT
    cell.fill = HEADER_FILL
    cell.alignment = Alignment(horizontal="center")
    cell.border = THIN_BORDER

for row_idx, (date, close, vol) in enumerate(rows, 2):
    # Date
    c_date = ws_data.cell(row=row_idx, column=1, value=date)
    c_date.font = DATA_FONT
    c_date.alignment = Alignment(horizontal="center")
    c_date.border = THIN_BORDER

    # Close
    c_close = ws_data.cell(row=row_idx, column=2, value=close)
    c_close.font = DATA_FONT
    c_close.number_format = '#,##0.00'
    c_close.alignment = Alignment(horizontal="right")
    c_close.border = THIN_BORDER

    # Volume
    c_vol = ws_data.cell(row=row_idx, column=3, value=vol)
    c_vol.font = DATA_FONT
    c_vol.number_format = '#,##0'
    c_vol.alignment = Alignment(horizontal="right")
    c_vol.border = THIN_BORDER

# Column widths
ws_data.column_dimensions["A"].width = 14
ws_data.column_dimensions["B"].width = 14
ws_data.column_dimensions["C"].width = 18

# Freeze header row
ws_data.freeze_panes = "A2"

total_rows = len(rows) + 1  # +1 for header

# ── Sheet 2: Chart ──────────────────────────────────────────────────────
ws_chart = wb.create_sheet(title="Chart")
ws_chart.sheet_properties.tabColor = "4ecdc4"

# -- Combined chart: line for price, bar for volume --

# Price line chart (primary axis)
price_chart = LineChart()
price_chart.title = f"{SYMBOL} — Close Price & Volume (2020–Present)"
price_chart.style = 10
price_chart.width = 38
price_chart.height = 18
price_chart.y_axis.title = "Close Price ($)"
price_chart.y_axis.numFmt = '$#,##0'
price_chart.x_axis.title = "Date"
price_chart.x_axis.tickLblSkip = max(1, len(rows) // 20)  # ~20 labels
price_chart.x_axis.tickLblPos = "low"
price_chart.legend.position = "b"

dates_ref = Reference(ws_data, min_col=1, min_row=2, max_row=total_rows)
price_ref = Reference(ws_data, min_col=2, min_row=1, max_row=total_rows)
price_chart.add_data(price_ref, titles_from_data=True)
price_chart.set_categories(dates_ref)

price_series = price_chart.series[0]
price_series.graphicalProperties.line.width = 18000  # ~1.5pt in EMUs
price_series.graphicalProperties.line.solidFill = "e74c3c"  # red

# Volume bar chart (secondary axis)
vol_chart = BarChart()
vol_ref = Reference(ws_data, min_col=3, min_row=1, max_row=total_rows)
vol_chart.add_data(vol_ref, titles_from_data=True)
vol_chart.y_axis.title = "Volume"
vol_chart.y_axis.numFmt = '#,##0'
vol_chart.y_axis.axId = 200

vol_series = vol_chart.series[0]
vol_series.graphicalProperties.solidFill = "3498db50"  # blue, semi-transparent

# Combine: price on primary axis, volume on secondary
price_chart.y_axis.crosses = "min"
vol_chart.y_axis.crosses = "max"
price_chart += vol_chart

ws_chart.add_chart(price_chart, "A1")

# ── Save ────────────────────────────────────────────────────────────────
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
wb.save(OUTPUT_FILE)
print(f"Saved → {OUTPUT_FILE}")
