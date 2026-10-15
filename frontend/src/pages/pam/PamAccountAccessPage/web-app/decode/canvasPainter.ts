export const createCanvasPainter = (canvas: HTMLCanvasElement) => {
  const context = canvas.getContext("2d");
  return (frame: VideoFrame) => {
    try {
      context?.drawImage(frame, 0, 0, canvas.width, canvas.height);
    } finally {
      frame.close();
    }
  };
};
