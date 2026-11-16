# Demo recording: click list

Layout (same on every screen):
- **TOP BAR**, left to right: site dropdown, layer buttons (slope, sand, roughness, radiation, solar, comms, **◎ WALKBACK**, **✨ DISCOVERY**), **🪨 3D STRATA**, **📡 RELAY**, ⚡ SHELTER, **🧑‍🚀 VISOR POV**, small walk slider, **Sol** slider (leave at 14.0).
- **RIGHT PANEL** (the wrist HUD): at the top a green **🔗 FULL LOOP** button and the waypoint buttons (**◆ WP-1**, WP-2, WP-3); below them the drawer **🎒 Science Loadout** (click its title to open it).
- **BOTTOM BAR**: status text (shows what the last click did).
- **MAP**: click = route, **Shift+Click** = hazard, drag = orbit, scroll = zoom.

## Before recording
1. Terminal: `cd ~/Desktop/mars-survival-nav && npm run dev`, open the URL, full-screen the browser (Ctrl+Cmd+F), Do Not Disturb on.
2. Dropdown = Mount Sharp, Sol = 14.0, reload with Cmd+R so everything is reset.
3. Cmd+Shift+5 -> Record Entire Screen -> Options: Save to Desktop, Show Mouse Clicks on -> **Record**. Wait 2 s, then start below.
4. Stop: Cmd+Ctrl+Esc.

## Click list (wait times are how long to stay before the next click)

| # | Click | Wait | You should see |
|---|---|---|---|
| 1 | Right panel: **◆ WP-1** | 12 s | Red line + cyan line. HUD: 13.5° / 0 m sand. Red one is 45.1° / 278 m |
| 2 | Top bar: **◎ WALKBACK** | 5 s | White ring on the terrain (about 90 % reachable) |
| 3 | Right panel: click **🎒 Science Loadout** title to open it | 2 s | Instrument checkboxes appear |
| 4 | Tick **all 6 instruments** (one after another, 1 s each) | 6 s | Pack 40.4 kg, ring shrinks (about 58 %), HUD says **WALKBACK EXCEEDED** (110 L / 95 L). If no route is drawn, click **◆ WP-1** again |
| 5 | Same drawer, top item: tick **🛞 Companion Utility Rover Haul** | 8 s | HUD flips to **SAFE RETURN** (9.8 L / 95 L), gold rover line + 🛞 ROVER BASECAMP at the ridge |
| 6 | Untick **🛞 Rover Haul** | 1 s | Back to the normal route |
| 7 | Right panel top: **🔗 FULL LOOP** | 8 s | Loop HAB → WP-2 → WP-1 → WP-3 → HAB, 4.70 km, 167 L / 180 L |
| 8 | Top bar: **✨ DISCOVERY** | 6 s | Entropy contact overlay |
| 9 | Top bar: **🪨 3D STRATA** | 3 s, then drag the map a little to tilt the view for 5 s | Translucent underground layers under the loop |
| 10 | **Shift+Click** on the cyan line of the **southern leg** (the last leg back to the Hab, nearest you) | 8 s | Red ⚠️ cone, loop re-routes (4.74 km). Bottom bar says hazard **added**. If it says ignored/cleared, Shift+Click again a bit farther along the line |
| 11 | (nothing, just point the cursor at the red ring) | 4 s | Nav CEP ±11.4 m in the HUD |
| 12 | Top bar: **📡 RELAY** | 8 s | Gold tower, coverage 76 % → 88 %, Nav CEP about ±3.9 m |
| 13 | Top bar: **🧑‍🚀 VISOR POV** | 10 s | Astronaut view walking the route, ground photo in the corner |
| 14 | Click the small ground photo (🔍 ZOOM) | 4 s | Big image |
| 15 | Click outside the image / its close button to close it | 1 s | |
| 16 | Top bar: **🛰️ ORBITAL** (same button as POV) | 2 s | Back to the map |
| 17 | Top bar dropdown: **Deuteronilus Mensae** | 6 s | New terrain loads |
| 18 | Top bar dropdown: **Arcadia Planitia** | 6 s | New terrain loads |

Stop recording. Total about 2 min.

## If something goes wrong
- **Step 10 says "Loop Blocked":** Shift+Click the red cone again to clear it, then re-click. 
- **Wrong numbers or odd state:** stop, Cmd+R, redo from step 1 (the clicks change state).
- **No gold rover line in step 5:** keep going, the HUD shot still works. Tell me afterwards.
- **Switching sites shows "SYNTHETIC sector":** a data file failed to load. Reload and wait 1 s between switches.

## After
QuickTime Player -> open the .mov on the Desktop -> Edit -> Trim (Cmd+T) -> drag the yellow handles -> Trim -> File -> Export As -> 1080p.
