# Rectangle coverage with PingRoom

Find the covered, uncovered and overlapping parts of a rectangular workspace after its owner marks each declared footprint Active or Inactive. PingRoom collects the choices; code exports exact areas and a grid showing which footprints cover each cell.

The example is a packing floor with two work zones. Calculations use the supplied geometry. It does not measure physical coverage, control equipment or change a floor plan.

## Try it offline

Choose **Use this template**, clone your copy and install Node.js 22 or newer:

```sh
npm ci
npm test
npm run demo
cp examples/plan.json plan.json
cp config.example.json config.json
npm run preview
```

The demo covers both zones active, all zones inactive and an Unknown answer. It uses the real pinned SDK with a local mock transport, requires no credentials and removes its temporary files. No live phone delivery is tested.

## Supply a plan

Edit `plan.json` before starting. `preview` validates and prints the complete input without contacting PingRoom.

- `planId`: a stable lowercase slug, at most 40 characters.
- `title` and `unit`: trimmed descriptions, at most 40 and 12 UTF-16 units. All geometry uses this one length unit and a common coordinate frame.
- `workspace`: exactly `x0`, `y0`, `x1`, `y1`, defining one positive-area rectangle.
- `footprints`: 1–8 rectangles with those same four coordinates plus `id`, `label` and `description`.

Coordinates are integers from −1,000,000 through 1,000,000. Negative coordinates are valid; negative zero, fractions, numeric strings and nonfinite values are rejected. Every rectangle requires `x0 < x1` and `y0 < y1`. Every footprint must lie fully inside the workspace. There is no clipping, rotation, geographic projection or unit conversion.

Footprint IDs must be unique, start with a lowercase letter, use only lowercase letters, digits, `_` or `-`, and contain at most 12 characters. Reserved object names are rejected. Labels allow 32 UTF-16 units and descriptions allow 80. Metadata must be nonempty, trimmed, well formed and free of control characters. Unknown fields are rejected. The assembled Question must fit 500 UTF-16 units; combining field maxima may exceed that limit. Input files are limited to 64 KiB and outputs to 1 MiB.

Footprints sort by ASCII ID before hashing and asking. Reordering the array preserves identity; changes to geometry, units or meanings do not. Two footprints may have identical geometry if their IDs differ: when both are active, they contribute depth two over that area.

## Connect and collect activity

Install [PingRoom](https://pingroom.io/i), then run:

```sh
npm run connect
npm run inspect
```

Approve the printed connection link and grant the intended standard private room. Verify the owner in the app, then replace the fixture participant UUID in `config.json` with their exact member UUID and label. A display name alone does not establish identity.

For an existing robot connection, copy `.env.example` to `.env` and set both `PINGROOM_TOKEN` and `PINGROOM_ROOM`. A partial or blank pair fails. The connection needs room-list access and permission to create and read Questions in the selected room.

```sh
npm start
```

Each invocation creates at most one direct Question or reads the pending one. After the owner answers, run again to save that answer, then again to ask about the next footprint. Questions last 15 minutes. There is no automatic polling or resend.

Choose **Active** to include the declared footprint, **Inactive** to exclude it, or **Unknown** when its activity is unresolved. These choices record the owner's declarations. Unknown, missing evidence, expiry, cancellation or an invalid answer withholds the whole analysis; later choices can still be collected.

Each Question sends the plan title, unit, workspace bounds, current footprint ID, label, description and bounds to PingRoom, along with source/policy hashes. The application checks the request, room, intended human, asking registration and timestamps against saved evidence.

## Read and export coverage

```sh
npm run status
npm run report
npm run export
```

These commands run locally. `report` writes `.coverage/report.json`, including partial evidence. `export` requires a known valid choice for every footprint and writes `.coverage/analysis.json`. Both retain the input and attributed answers alongside the calculation.

Geometry uses half-open rectangles `[x0,x1) × [y0,y1)`. Touching edges or corners have no overlap area. Code sorts all workspace and footprint edges, including inactive footprint edges, into a stable grid of at most 289 cells. Each cell has positive area and a constant set of active covering footprints. Cells are ordered by increasing `y0`, then `x0`; `coveringIds` are in ASCII ID order.

The analysis includes:

| Field | Meaning |
| --- | --- |
| `workspaceArea` | Total area of the declared workspace. |
| `coveredArea` | Union area: each cell covered by at least one active footprint counts once. |
| `uncoveredArea` | Area covered by no active footprint. |
| `overlapArea` | Area with depth at least two, counted once regardless of depth. |
| `activeFootprintArea` | Sum of active rectangle areas, counting overlap repeatedly. |
| `depthWeightedArea` | Sum of each cell area multiplied by its depth; equals `activeFootprintArea`. |
| `depthHistogram` | Area at every depth from zero through the number of active footprints, including zero-area bins. |
| `cells` | Bounds, area, depth and active covering IDs for every grid cell. |
| `xEdges`, `yEdges` | The coordinate-compression grid. |

Areas use the square of the supplied length unit. The coordinate limits bound workspace area to 4,000,000,000,000 and depth-weighted area to 32,000,000,000,000, both exact JavaScript integers. Code checks that covered plus uncovered area equals workspace area and that depth-weighted area equals the active footprint sum.

All Inactive is a complete result: `allInactive: true`, zero covered area and the entire workspace uncovered. Inactive edges may subdivide uncovered cells without changing their total area. `physicalCoverageVerified` remains `false` for every result.

Run/recover exits `0` for complete, `1` for errors, `2` for failed or incomplete answers, `3` for pending/ready/interrupted work and `4` for uncertain creation. Successful local reporting exits `0`, even for partial evidence; inspect its JSON status. Refused exports exit `1`.

## Resume and adapt

After a lost creation response, preserve `.coverage/state.json`. Run `npm run find-id`, inspect candidates, then `npm run recover -- QUESTION_UUID` for the exact original Question. An empty bounded search does not prove creation failed. Never delete state to retry a send.

Pairing retains its pending bearer/session or uncertain creation intent. Resume known pairing with `npm run connect`; resolve or revoke uncertain or expired registrations in Connected Agents before starting a new connection.

Keep input, configuration, room and credentials unchanged throughout a session. Resolve the original session before archiving `.coverage/` for a revised plan. Remove a stale lock only after confirming no process is active. Root inputs, credentials and runtime state are ignored by Git. Atomic state/output writes use private files (`0600`) and directories (`0700`). Hashes detect mismatches; they are not independently signed history.

Adapt your floor-plan exporter to produce these bounded rectangles. Consume `analysis.cells` for a local diagram or `coveredArea` and `depthHistogram` for reporting. Add equipment control or external publication in a separate adapter; neither is implemented here. Obstacles, nonrectangular shapes, sensor measurements and real-world effectiveness require their own models and evidence.

The starter pins `@pingroom/sdk` 0.8.0 with a lockfile. `.npmrc` requests exact saves and a 14-day minimum release age where npm supports it. Commit-pinned GitHub Actions check Node 22 and 24. Tests include 2,736 independent raster comparisons, boundary contacts, nested and identical geometry, failure/recovery paths, pairing, actual CLI behavior and maximum output size. MIT licensed.
