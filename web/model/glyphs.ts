// Marker symbols as line drawings on a 24×24 grid, stroked in one colour like the rest of the UI:
// on the map (canvas, see styles.ts) and in lists (SVG, see icons.tsx). Up to 0.17 the marker
// types used emoji, which bring their own colours.
export const GLYPHS: Record<string, { name: string; paths: string[] }> = {
  poi: { name: 'Stecknadel', paths: ['M12 21s-6.5-5.8-6.5-11.2a6.5 6.5 0 0 1 13 0C18.5 15.2 12 21 12 21z', 'M12 7.3a2.5 2.5 0 1 1 0 5a2.5 2.5 0 1 1 0-5z'] },
  volcano: { name: 'Vulkan', paths: ['M3 20l6-10h6l6 10z', 'M12 7V3', 'M9.5 7.5L8 4.5', 'M14.5 7.5L16 4.5'] },
  mountain: { name: 'Berg', paths: ['M2 20l7-12 4 6 3-4 6 10z', 'M7.3 11l1.7 1.5 1.6-1.4'] },
  ruin: { name: 'Ruine', paths: ['M4 20h16', 'M5 9h14', 'M4 9l8-5 8 5', 'M7 9v11', 'M11 9v11', 'M15 9v6', 'M18 9v3'] },
  mine: { name: 'Mine', paths: ['M5 19L16 8', 'M9 5.5c4-2 8.5-.5 10.5 4c-3-1.6-6.2-1.6-8.6.2z'] },
  cave: { name: 'Höhle', paths: ['M2.5 20c0-8.5 4.3-14 9.5-14s9.5 5.5 9.5 14z', 'M8 20c0-4.4 1.8-7.5 4-7.5s4 3.1 4 7.5'] },
  shrine: { name: 'Heiligtum', paths: ['M3.5 5.5c5.5 1.3 11.5 1.3 17 0', 'M5 9.5h14', 'M7 7v13', 'M17 7v13', 'M12 6.5v3'] },
  battle: { name: 'Schlacht', paths: ['M5 5l14 14', 'M19 5L5 19', 'M3.5 16.5l4 4', 'M16.5 20.5l4-4'] },
  castle: { name: 'Burg', paths: ['M4 20V9h3V6h2v3h2V6h2v3h2V6h2v3h3v11z', 'M10 20v-5h4v5'] },
  tower: { name: 'Turm', paths: ['M8 20l1-11h6l1 11z', 'M7 9V5h2v2h2V5h2v2h2V5h2v4z', 'M11 20v-3.5h2V20'] },
  bridge: { name: 'Brücke', paths: ['M2 10h20', 'M4 10v9', 'M20 10v9', 'M4 19c2.2-5.5 13.8-5.5 16 0'] },
  harbor: { name: 'Anker', paths: ['M12 7v14', 'M9 10h6', 'M12 3a2 2 0 1 1 0 4a2 2 0 1 1 0-4z', 'M5 14c0 4 3 7 7 7s7-3 7-7', 'M3 14h4', 'M17 14h4'] },
  lighthouse: { name: 'Leuchtturm', paths: ['M9 21l1.5-11h3L15 21z', 'M8 10h8', 'M10 10V6.5h4V10', 'M3.5 5l4 2.5', 'M20.5 5l-4 2.5', 'M3 10h3', 'M18 10h3'] },
  monster: { name: 'Seeungeheuer', paths: ['M2 16c2-3 4-3 6 0s4 3 6 0 4-3 6 0', 'M16 13.5c0-4.5 1.8-7.5 4.5-7.5', 'M20.5 6l-1.5 3'] },
  treasure: { name: 'Edelstein', paths: ['M6.5 4h11l3.5 5-9 11L3 9z', 'M3 9h18', 'M9.5 4L8 9l4 11 4-11-1.5-5'] },
  spring: { name: 'Quelle', paths: ['M12 3c4 5 6 8.2 6 11a6 6 0 0 1-12 0c0-2.8 2-6 6-11z', 'M9 14.5a3 3 0 0 0 3 3'] },
  portal: { name: 'Portal', paths: ['M12 3c4 0 6.5 4 6.5 9s-2.5 9-6.5 9-6.5-4-6.5-9 2.5-9 6.5-9z', 'M12 7.5c1.9 0 3 2 3 4.5s-1.1 4.5-3 4.5-3-2-3-4.5 1.1-4.5 3-4.5z'] },
  camp: { name: 'Lager', paths: ['M2.5 20L12 4l9.5 16z', 'M9 20l3-6 3 6'] },
  grave: { name: 'Grab', paths: ['M7 20V9.5a5 5 0 0 1 10 0V20', 'M4 20h16', 'M12 10v6', 'M9.5 12.5h5'] },
  wreck: { name: 'Wrack', paths: ['M3 14h18l-3 5H6z', 'M10 14V4l6 6.5h-6', 'M3 21c2-1 4-1 6 0s4 1 6 0 4-1 6 0'] },
  forest: { name: 'Wald', paths: ['M8 3l-5 9h3l-3 5h10l-3-5h3z', 'M8 17v4', 'M16.5 7l-3 5.5h2l-2.5 4.5h7l-2.5-4.5h2z', 'M16.5 17v4'] },
  star: { name: 'Stern', paths: ['M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6-4.5-4.2 6.1-.7z'] },
  skull: { name: 'Gefahr', paths: ['M5 11a7 7 0 0 1 14 0c0 2.5-1.2 4-2.5 4.8V19h-9v-3.2C6.2 15 5 13.5 5 11z', 'M9 10.5a1.3 1.3 0 1 1 0 2.6a1.3 1.3 0 1 1 0-2.6z', 'M15 10.5a1.3 1.3 0 1 1 0 2.6a1.3 1.3 0 1 1 0-2.6z', 'M10.5 19v-2.5', 'M13.5 19v-2.5'] },
}

export const GLYPH_OPTIONS = Object.entries(GLYPHS).map(([id, g]) => ({ id, name: g.name }))

/** the emoji of the built-in marker types up to 0.17, and the line symbol that replaces each */
export const LEGACY_GLYPHS: Record<string, string> = {
  '🌋': 'volcano', '🏛️': 'ruin', '⛏️': 'mine', '🕳️': 'cave', '⛩️': 'shrine', '⚔️': 'battle', '🏰': 'castle', '🗼': 'tower',
  '🌉': 'bridge', '⚓': 'harbor', '🐉': 'monster', '💎': 'treasure', '💧': 'spring', '🌀': 'portal', '⛺': 'camp', '🪦': 'grave',
  '⛵': 'wreck', '📍': 'poi',
}

/** the line symbol of a marker type's icon, or null when it is some other text */
export const glyphOf = (icon: string): string | null => (GLYPHS[icon] ? icon : (LEGACY_GLYPHS[icon] ?? null))
