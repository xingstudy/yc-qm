import qrcode from "qrcode-generator";

export function qrSvg(payload: string): string {
  const code = qrcode(0, "M");
  code.addData(payload, "Byte");
  code.make();
  return code
    .createSvgTag({ cellSize: 1, margin: 4, scalable: true })
    .replace("<svg ", '<svg shape-rendering="crispEdges" role="img" ');
}
