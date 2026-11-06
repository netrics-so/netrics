/**
 * A QR code encoder (ISO/IEC 18004) for the pairing screen's approval URL
 * (#307): byte mode, error correction level M, versions 1 to 10 (up to 213
 * bytes, far more than an approval URL needs) and the mask with the lowest
 * penalty. The tvOS app draws the same code with CoreImage's generator at
 * level M (NetricsKit QRCode); this is the browser's equivalent, in-repo
 * rather than a dependency. It follows the reference algorithm of Project
 * Nayuki's QR Code generator, whose output the tests compare against.
 */

/** A QR code's modules: `true` is dark; row-major, `size` × `size`. */
export interface QrMatrix {
  version: number;
  size: number;
  mask: number;
  modules: boolean[][];
}

const MAX_VERSION = 10;

/** Level M per version (index 0 unused): codewords per block, blocks. */
const ECC_CODEWORDS_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const NUM_ERROR_CORRECTION_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];

/** Level M's two format bits (ISO/IEC 18004 table 25). */
const ECL_M_FORMAT_BITS = 0;

/**
 * The QR code for `text` (UTF-8, byte mode, level M). `mask` forces a mask
 * pattern (0–7), for tests; by default the one with the lowest penalty.
 * Throws when the text does not fit version 10.
 */
export function encodeQr(text: string, mask?: number): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  for (; ; version++) {
    if (version > MAX_VERSION) {
      throw new RangeError("Text too long for a version 10 QR code");
    }
    const countBits = version <= 9 ? 8 : 16;
    const needed = 4 + countBits + bytes.length * 8;
    if (needed <= numDataCodewords(version) * 8) break;
  }

  // Mode indicator (byte = 0100), character count, data.
  const bits: number[] = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) appendBits(bits, byte, 8);

  // Terminator, byte alignment, then alternating pad bytes.
  const capacity = numDataCodewords(version) * 8;
  appendBits(bits, 0, Math.min(4, capacity - bits.length));
  appendBits(bits, 0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) {
    appendBits(bits, pad, 8);
  }
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]!;
    data.push(byte);
  }

  const qr = new Builder(version);
  qr.drawFunctionPatterns();
  qr.drawCodewords(addEccAndInterleave(data, version));

  let chosen = mask ?? -1;
  if (chosen === -1) {
    let best = Infinity;
    for (let candidate = 0; candidate < 8; candidate++) {
      qr.applyMask(candidate);
      qr.drawFormatBits(candidate);
      const penalty = qr.penaltyScore();
      if (penalty < best) {
        best = penalty;
        chosen = candidate;
      }
      qr.applyMask(candidate); // XOR again: undo
    }
  }
  if (!Number.isInteger(chosen) || chosen < 0 || chosen > 7) {
    throw new RangeError("Mask must be 0 to 7");
  }
  qr.applyMask(chosen);
  qr.drawFormatBits(chosen);
  return { version, size: qr.size, mask: chosen, modules: qr.modules };
}

function appendBits(bits: number[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

/** Data and error-correction modules, without function patterns. */
function numRawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function numDataCodewords(version: number): number {
  return (
    Math.floor(numRawDataModules(version) / 8) -
    ECC_CODEWORDS_PER_BLOCK[version]! * NUM_ERROR_CORRECTION_BLOCKS[version]!
  );
}

/** Splits the data into blocks, adds Reed–Solomon ECC, interleaves. */
function addEccAndInterleave(data: number[], version: number): number[] {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[version]!;
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[version]!;
  const rawCodewords = Math.floor(numRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const divisor = reedSolomonDivisor(blockEccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const length = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const block = data.slice(k, k + length);
    k += length;
    const ecc = reedSolomonRemainder(block, divisor);
    // Short blocks get a placeholder so every block has the same length.
    if (i < numShortBlocks) block.push(0);
    blocks.push([...block, ...ecc]);
  }

  const result: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => {
      // Skip the short blocks' placeholder.
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) {
        result.push(block[i]!);
      }
    });
  }
  return result;
}

function reedSolomonDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i]! ^= gfMultiply(coef, factor);
    });
  }
  return result;
}

/** Multiplication in GF(2^8) modulo x^8 + x^4 + x^3 + x^2 + 1. */
function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

class Builder {
  readonly size: number;
  readonly modules: boolean[][];
  private readonly isFunction: boolean[][];

  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = grid(this.size);
    this.isFunction = grid(this.size);
  }

  drawFunctionPatterns(): void {
    const { size } = this;
    for (let i = 0; i < size; i++) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(size - 4, 3);
    this.drawFinder(3, size - 4);

    const positions = this.alignmentPositions();
    const n = positions.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        // Not over the three finder patterns.
        if (!(
          (i === 0 && j === 0) ||
          (i === 0 && j === n - 1) ||
          (i === n - 1 && j === 0)
        )) {
          this.drawAlignment(positions[i]!, positions[j]!);
        }
      }
    }
    // Reserve the format areas (drawn for real once the mask is known).
    this.drawFormatBits(0);
    this.drawVersion();
  }

  drawFormatBits(mask: number): void {
    const data = (ECL_M_FORMAT_BITS << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) !== 0;
    const { size } = this;

    for (let i = 0; i <= 5; i++) this.setFunction(8, i, bit(i));
    this.setFunction(8, 7, bit(6));
    this.setFunction(8, 8, bit(7));
    this.setFunction(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, bit(i));

    for (let i = 0; i < 8; i++) this.setFunction(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.setFunction(8, size - 15 + i, bit(i));
    this.setFunction(8, size - 8, true); // The dark module.
  }

  private drawVersion(): void {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunction(a, b, dark);
      this.setFunction(b, a, dark);
    }
  }

  private drawFinder(x: number, y: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) {
          this.setFunction(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    }
  }

  private drawAlignment(x: number, y: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.setFunction(
          x + dx,
          y + dy,
          Math.max(Math.abs(dx), Math.abs(dy)) !== 1,
        );
      }
    }
  }

  private alignmentPositions(): number[] {
    if (this.version === 1) return [];
    const numAlign = Math.floor(this.version / 7) + 2;
    const step = Math.ceil((this.version * 4 + 4) / (numAlign * 2 - 2)) * 2;
    const result = [6];
    for (let pos = this.size - 7; result.length < numAlign; pos -= step) {
      result.splice(1, 0, pos);
    }
    return result;
  }

  private setFunction(x: number, y: number, dark: boolean): void {
    this.modules[y]![x] = dark;
    this.isFunction[y]![x] = true;
  }

  /** The zigzag placement, two columns at a time from the bottom right. */
  drawCodewords(data: number[]): void {
    const { size } = this;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!this.isFunction[y]![x] && i < data.length * 8) {
            this.modules[y]![x] =
              ((data[i >>> 3]! >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
          // Remainder bits stay light.
        }
      }
    }
  }

  /** XORs the mask over the data modules; applying it twice undoes it. */
  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (!this.isFunction[y]![x] && maskBit(mask, x, y)) {
          this.modules[y]![x] = !this.modules[y]![x];
        }
      }
    }
  }

  penaltyScore(): number {
    const { size, modules } = this;
    let result = 0;
    for (const vertical of [false, true]) {
      for (let a = 0; a < size; a++) {
        let runColor = false;
        let run = 0;
        const history = [0, 0, 0, 0, 0, 0, 0];
        for (let b = 0; b < size; b++) {
          const dark = vertical ? modules[b]![a]! : modules[a]![b]!;
          if (dark === runColor) {
            run++;
            if (run === 5) result += PENALTY_N1;
            else if (run > 5) result++;
          } else {
            this.addHistory(run, history);
            if (!runColor) result += this.countFinderLike(history) * PENALTY_N3;
            runColor = dark;
            run = 1;
          }
        }
        result += this.terminateAndCount(runColor, run, history) * PENALTY_N3;
      }
    }

    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const color = modules[y]![x];
        if (
          color === modules[y]![x + 1] &&
          color === modules[y + 1]![x] &&
          color === modules[y + 1]![x + 1]
        ) {
          result += PENALTY_N2;
        }
      }
    }

    let dark = 0;
    for (const row of modules) for (const cell of row) if (cell) dark++;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    return result + k * PENALTY_N4;
  }

  private countFinderLike(history: number[]): number {
    const n = history[1]!;
    const core =
      n > 0 &&
      history[2] === n &&
      history[3] === n * 3 &&
      history[4] === n &&
      history[5] === n;
    return (
      (core && history[0]! >= n * 4 && history[6]! >= n ? 1 : 0) +
      (core && history[6]! >= n * 4 && history[0]! >= n ? 1 : 0)
    );
  }

  private terminateAndCount(
    runColor: boolean,
    run: number,
    history: number[],
  ): number {
    if (runColor) {
      this.addHistory(run, history);
      run = 0;
    }
    this.addHistory(run + this.size, history); // The light border.
    return this.countFinderLike(history);
  }

  private addHistory(run: number, history: number[]): void {
    if (history[0] === 0) run += this.size; // The light border.
    history.pop();
    history.unshift(run);
  }
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function grid(size: number): boolean[][] {
  return Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );
}

/**
 * The dark modules as one SVG path (a unit square per module, runs of a row
 * merged), offset by the quiet zone.
 */
export function qrPath(qr: QrMatrix, quietZone: number): string {
  const parts: string[] = [];
  qr.modules.forEach((row, y) => {
    for (let x = 0; x < qr.size; x++) {
      if (!row[x]) continue;
      let end = x;
      while (end + 1 < qr.size && row[end + 1]) end++;
      parts.push(
        `M${x + quietZone} ${y + quietZone}h${end - x + 1}v1h${-(end - x + 1)}z`,
      );
      x = end;
    }
  });
  return parts.join("");
}
