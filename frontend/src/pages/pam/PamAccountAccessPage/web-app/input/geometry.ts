export type TRect = { left: number; top: number; width: number; height: number };

// The canvas uses `object-fit: contain`, so its content box is letterboxed inside the element rect.
export const contentBox = (rect: TRect, fbWidth: number, fbHeight: number) => {
  const scale = Math.min(rect.width / fbWidth, rect.height / fbHeight);
  const width = fbWidth * scale;
  const height = fbHeight * scale;
  return {
    scale,
    left: rect.left + (rect.width - width) / 2,
    top: rect.top + (rect.height - height) / 2,
    width,
    height
  };
};
