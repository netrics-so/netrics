import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { encodeQr, qrPath, type QrMatrix } from "./qr-code";

// Expected matrices come from the reference implementation, Project
// Nayuki's QR Code generator (Python `qrcodegen` 1.8.0): byte segment,
// Ecc.MEDIUM, versions 1–40, automatic or forced mask, no ECC boost. They
// are stored as the SHA-256 of the rows ("1" dark, "0" light, joined by
// "\n"), with one small matrix spelled out.

function rows(qr: QrMatrix): string {
  return qr.modules
    .map((row) => row.map((dark) => (dark ? "1" : "0")).join(""))
    .join("\n");
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const APPROVE = "https://app.example.com/devices/approve?code=ABCD-EFGH";

describe("encodeQr", () => {
  it("draws version 1 module for module like the reference", () => {
    const qr = encodeQr("netrics");
    expect(qr.version).toBe(1);
    expect(qr.size).toBe(21);
    expect(qr.mask).toBe(0);
    expect(rows(qr)).toBe(
      [
        "111111100010101111111",
        "100000101011101000001",
        "101110100001001011101",
        "101110100110001011101",
        "101110101000101011101",
        "100000100010101000001",
        "111111101010101111111",
        "000000000111100000000",
        "101010100011000010010",
        "011011011110001100011",
        "100000100100100011111",
        "101110000010001010011",
        "111110111110101011010",
        "000000001001010010011",
        "111111100011011110111",
        "100000100011110010001",
        "101110101001011011011",
        "101110100010001111010",
        "101110101100100110001",
        "100000100100001000010",
        "111111101010101000011",
      ].join("\n"),
    );
  });

  it.each([
    {
      text: "https://netrics.tv/ABCD-EFGH",
      version: 3,
      mask: 0,
      sha256:
        "2b9a1a98a0e572ecf9f40d59614cc3c037651b0de3b10b2e845317ca076f0d20",
    },
    {
      text: APPROVE,
      version: 4,
      mask: 2,
      sha256:
        "41e456760eb4e581cf22cbc8b353ee8948bbf4a9ccc6f177817908380b4030c6",
    },
    {
      // UTF-8 bytes, more than one block.
      text: "Grüße aus Köln — netrics 📺",
      version: 3,
      mask: 3,
      sha256:
        "7651b047e1e92bf3315733f358605bdbb8263b90075a7fa307518c4984bba8bc",
    },
    {
      // Version information blocks (7+), short and long blocks.
      text: "https://dashboards.internal.example.org:8443/netrics/devices/approve?code=K7F2-9QXA&utm_source=tv&utm_medium=kiosk&lang=de-DE",
      version: 8,
      mask: 2,
      sha256:
        "f84e7d88de60931eb1a06b702ae61e1d52249c2a018435cc8205e6738779287a",
    },
    {
      // Version 10: a 16-bit character count.
      text: `https://a-very-long-self-hosted-domain-name.example.com/some/deeply/nested/path/devices/approve?code=ABCD-EFGH&x=${"y".repeat(80)}`,
      version: 10,
      mask: 1,
      sha256:
        "b664a7d6e560a6ebf6f4c30e6de6ac1bb76b914087d0a9548d40bac66652c44e",
    },
  ])(
    "matches the reference for version $version",
    ({ text, version, mask, sha256: expected }) => {
      const qr = encodeQr(text);
      expect(qr.version).toBe(version);
      expect(qr.size).toBe(version * 4 + 17);
      expect(qr.mask).toBe(mask);
      expect(sha256(rows(qr))).toBe(expected);
    },
  );

  it("matches the reference with every mask forced", () => {
    const expected = [
      "9ff3eae6dfa59ed777fe5aa440e37cc46dd06af6a43d160836fda43a782fb751",
      "90be075aedfce81e8ce61b8fc043b68a0e8ee249f881462bff5df9655d21cd48",
      "41e456760eb4e581cf22cbc8b353ee8948bbf4a9ccc6f177817908380b4030c6",
      "93d40693ecff0316dd24215d96a090f836b9ccfd12027f04faf0aa18f8654180",
      "de774564710d24e080d957ab49e99d665fe6b9ff83187c899576fe666205e3be",
      "90d727b388ba7283aa2b08c078921e5145c7c3c490afa89eb912baaafb8b57f3",
      "8980073880acef071c8d3dd35188d9eb2cb09992960aebbef80d3cfd129df5aa",
      "02f0a1955f725ec1c3f03bef95c89474b702627b0ef9c47f63160f7f44838905",
    ];
    expected.forEach((hash, mask) => {
      const qr = encodeQr(APPROVE, mask);
      expect(qr.mask).toBe(mask);
      expect(sha256(rows(qr))).toBe(hash);
    });
  });

  it("refuses text beyond version 10 and masks out of range", () => {
    expect(() => encodeQr("x".repeat(214))).toThrow(RangeError);
    expect(encodeQr("x".repeat(213)).version).toBe(10);
    expect(() => encodeQr("netrics", 8)).toThrow(RangeError);
  });
});

describe("qrPath", () => {
  it("draws each row's dark runs as rectangles inside the quiet zone", () => {
    const qr: QrMatrix = {
      version: 1,
      size: 3,
      mask: 0,
      modules: [
        [true, true, false],
        [false, false, false],
        [true, false, true],
      ],
    };
    expect(qrPath(qr, 4)).toBe("M4 4h2v1h-2zM4 6h1v1h-1zM6 6h1v1h-1z");
  });
});
