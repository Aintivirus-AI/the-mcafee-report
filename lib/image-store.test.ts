import { describe, it, expect } from "vitest";
import { isValidRasterImage } from "./image-store";

// Helper to make a Buffer from a hex string
function hex(...bytes: number[]): Buffer {
  return Buffer.from(bytes);
}

describe("isValidRasterImage — valid formats", () => {
  it("accepts PNG", () => {
    const png = hex(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    expect(isValidRasterImage(png)).toBe(true);
  });

  it("accepts JPEG", () => {
    const jpeg = hex(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10);
    expect(isValidRasterImage(jpeg)).toBe(true);
  });

  it("accepts GIF", () => {
    const gif = hex(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);
    expect(isValidRasterImage(gif)).toBe(true);
  });

  it("accepts WebP", () => {
    const webp = hex(0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50);
    expect(isValidRasterImage(webp)).toBe(true);
  });
});

describe("isValidRasterImage — SVG/XML rejection", () => {
  it("rejects plain SVG starting with <svg", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(isValidRasterImage(svg)).toBe(false);
  });

  it("rejects SVG with <?xml declaration", () => {
    const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(isValidRasterImage(svg)).toBe(false);
  });

  it("rejects SVG with UTF-8 BOM (was bypassable before fix)", () => {
    // BOM: EF BB BF then <svg ...>
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const content = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>xss</script></svg>');
    const svg = Buffer.concat([bom, content]);
    expect(isValidRasterImage(svg)).toBe(false);
  });

  it("rejects SVG with leading whitespace before <svg", () => {
    const svg = Buffer.from('   \n<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(isValidRasterImage(svg)).toBe(false);
  });

  it("rejects buffer that is too short", () => {
    expect(isValidRasterImage(Buffer.from([0x89, 0x50]))).toBe(false);
  });
});
