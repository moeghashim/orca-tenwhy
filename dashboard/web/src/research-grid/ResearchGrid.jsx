import { DataEditor, GridCellKind } from "@glideapps/glide-data-grid";
import { useCallback, useMemo, useState } from "react";
import { KIND, researchToGridModel } from "./model.js";
import { GRID_ROW_HEIGHT, gridHeight, gridTheme, gridWidth } from "./theme.js";

const KIND_MAP = {
  [KIND.Text]: GridCellKind.Text,
  [KIND.Number]: GridCellKind.Number,
  [KIND.Uri]: GridCellKind.Uri,
};

function toGridCell(cell) {
  const kind = KIND_MAP[cell.kind] || GridCellKind.Text;
  return { ...cell, kind };
}

export function ResearchGrid({ research, comparison, variant = "customer" }) {
  const model = useMemo(() => researchToGridModel(research, comparison), [research, comparison]);
  const [tabId, setTabId] = useState(model.tabs[0]?.id || "competitors");
  const tab = model.tabs.find((t) => t.id === tabId) || model.tabs[0];
  const columns = tab?.columns || [];
  const rows = tab?.rows || [];
  const getCellContent = useCallback(
    ([col, row]) => toGridCell(rows[row]?.[col] || { kind: KIND.Text, allowOverlay: false, displayData: "", data: "" }),
    [rows],
  );
  const width = gridWidth(columns);
  const height = gridHeight(rows.length);
  const theme = useMemo(() => gridTheme(), []);
  return (
    <div className="research-grid" data-variant={variant}>
      <div className="pills research-grid-tabs" data-grid-tabs="1">
        {model.tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            className={"pill" + (t.id === tab.id ? " on" : "")}
            data-grid-tab={t.id}
            onClick={() => setTabId(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <DataEditor
        columns={columns}
        rows={rows.length}
        getCellContent={getCellContent}
        width={width}
        height={height}
        rowHeight={GRID_ROW_HEIGHT}
        headerHeight={GRID_ROW_HEIGHT}
        theme={theme}
        smoothScrollX
        smoothScrollY
        getCellsForSelection
        columnSelect="none"
        rowSelect="none"
        rangeSelect="none"
      />
    </div>
  );
}
