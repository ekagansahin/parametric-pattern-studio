// Clipping plane calculation (Step 7 logic): 100% = model fully visible,
// 0% = fully clipped. Plane normal (0,-1,0) -> the part with y <= constant is visible.
// Pure function — used in viewer and Node tests.
export function clipConstant(pct, minY, maxY) {
  const top = maxY + 0.01, bottom = minY - 0.01;
  return bottom + ((top - bottom) * pct) / 100;
}
