import { tokens } from "../status.js";

const ROW = tokens.space.tableRowHeight;

export const GRID_ROW_HEIGHT = ROW;

export function gridTheme() {
  return {
    accentColor: tokens.color.accent.link,
    accentFg: tokens.color.bg.inset,
    accentLight: "rgba(37,99,235,0.10)",
    textDark: tokens.color.text.primary,
    textMedium: tokens.color.text.secondary,
    textLight: tokens.color.text.muted,
    textBubble: tokens.color.text.primary,
    textHeader: tokens.color.text.secondary,
    textHeaderSelected: tokens.color.bg.inset,
    bgIconHeader: tokens.color.text.muted,
    fgIconHeader: tokens.color.bg.inset,
    bgCell: tokens.color.bg.inset,
    bgCellMedium: tokens.color.bg.surface,
    bgHeader: tokens.color.bg.surface,
    bgHeaderHasFocus: tokens.color.bg.raised,
    bgHeaderHovered: tokens.color.bg.raised,
    bgBubble: tokens.color.bg.raised,
    bgBubbleSelected: tokens.color.accent.link,
    borderColor: tokens.color.border.subtle,
    horizontalBorderColor: tokens.color.border.subtle,
    drilldownBorder: tokens.color.border.default,
    linkColor: tokens.color.accent.link,
    cellHorizontalPadding: 12,
    cellVerticalPadding: 8,
    headerFontStyle: "600 12.5px",
    baseFontStyle: "13px",
    markerFontStyle: "12px",
    fontFamily: tokens.type.family.ui,
    editorFontSize: "13px",
    lineHeight: 1.4,
  };
}

export function gridHeight(rowCount) {
  const rows = Math.min(Math.max(rowCount, 1), 12);
  return rows * ROW + ROW;
}

export function gridWidth(columns) {
  const sum = (columns || []).reduce((n, c) => n + (c.width || 100), 0);
  return Math.max(sum + 8, 320);
}
