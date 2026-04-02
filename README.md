# DiveSSI Log Importer — Chrome Extension

Imports Shearwater dive computer CSV logs into DiveSSI My Dive Log
(https://my.divessi.com/mydivelog/add).

## Installation

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select this folder
4. The 🤿 icon will appear in your toolbar

## Usage

1. Log into **https://my.divessi.com** in Chrome
2. Navigate to **My Dive Log → Add** (keep this tab open)
3. Click the extension icon in the toolbar
4. Drag & drop your Shearwater CSV export onto the extension popup
5. Review the list of dives loaded
6. Click **Import All Dives**

The extension will:
- Navigate to the Add Dive page for each entry
- Fill in: date, max depth, duration, dive number, computer name, and notes
- Submit the form automatically
- Show ✓ / ✗ status per dive

## Dive fields mapped from Shearwater CSV

| CSV Column           | DiveSSI Field           |
|----------------------|-------------------------|
| Start Date           | Date                    |
| Max Depth            | Max Depth               |
| Max Time (seconds)   | Duration (minutes)      |
| Dive Number          | Dive Number             |
| Computer Model       | Dive Computer           |
| Deco Model + GF      | Notes                   |
| Start/End CNS %      | Notes                   |
| Surface Interval     | Notes                   |

## Troubleshooting

**"Could not find submit button"** — The DiveSSI form uses JavaScript rendering.
Open DevTools on the add-dive page, go to Console, and run:

```js
document.querySelectorAll('input, select, textarea, button').forEach(el => {
  console.log(el.tagName, el.name, el.type, el.placeholder, el.textContent.trim().slice(0, 40))
})
```

Share the output to help map fields correctly.

**Import stops mid-way** — The page may have logged you out. Re-login and resume
from where it stopped by removing already-imported dives from the CSV.

## Notes
- Exports from Shearwater Desktop: File → Export → Dive Log Summary (CSV)
- Units: depth in metres, duration in minutes (converted from seconds)
- The 1.5 second delay between dives is intentional to avoid rate limiting
