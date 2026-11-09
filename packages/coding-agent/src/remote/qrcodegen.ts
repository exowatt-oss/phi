/*
 * QR Code generator library (TypeScript) — trimmed port for phi remote.
 *
 * Copyright (c) Project Nayuki. (MIT License)
 * https://www.nayuki.io/page/qr-code-generator-library
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 * the Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 * - The above copyright notice and this permission notice shall be included in
 *   all copies or substantial portions of the Software.
 * - The Software is provided "as is", without warranty of any kind, express or
 *   implied, including but not limited to the warranties of merchantability,
 *   fitness for a particular purpose and noninfringement. In no event shall the
 *   authors or copyright holders be liable for any claim, damages or other
 *   liability, whether in an action of contract, tort or otherwise, arising from,
 *   out of or in connection with the Software or the use or other dealings in the
 *   Software.
 *
 * Changes from upstream: byte mode only (text is encoded as UTF-8 bytes), no
 * segment API, no ECI/kanji/numeric/alphanumeric modes, string ECC levels, and
 * phi's formatting conventions. The encoding algorithm (versions, ECC tables,
 * Reed-Solomon, interleaving, zigzag placement, masking and penalty scoring) is
 * unchanged from upstream.
 */

export type QrEcc = "L" | "M" | "Q" | "H";

const ECC_ORDINAL: Record<QrEcc, number> = { L: 0, M: 1, Q: 2, H: 3 };
/** Two-bit format value per ECC level (ISO/IEC 18004 table 12). */
const ECC_FORMAT_BITS: Record<QrEcc, number> = { L: 1, M: 0, Q: 3, H: 2 };

const MIN_VERSION = 1;
const MAX_VERSION = 40;

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

// biome-ignore format: keep the ISO/IEC 18004 tables aligned by version
const ECC_CODEWORDS_PER_BLOCK: number[][] = [
	// Version: (index 0 is padding, set to an illegal value)
	// 0,  1,  2,  3,  4,  5,  6,  7,  8,  9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40
	[-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // Low
	[-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28], // Medium
	[-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // Quartile
	[-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], // High
];

// biome-ignore format: keep the ISO/IEC 18004 tables aligned by version
const NUM_ERROR_CORRECTION_BLOCKS: number[][] = [
	// Version: (index 0 is padding, set to an illegal value)
	// 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40
	[-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25], // Low
	[-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49], // Medium
	[-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68], // Quartile
	[-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81], // High
];

function getBit(x: number, i: number): boolean {
	return ((x >>> i) & 1) !== 0;
}

function appendBits(val: number, len: number, bb: number[]): void {
	if (len < 0 || len > 31 || val >>> len !== 0) throw new RangeError("Value out of range");
	for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1);
}

/** Byte-mode character count indicator width for a version. */
function byteModeCountBits(version: number): number {
	return version <= 9 ? 8 : 16;
}

function getNumRawDataModules(ver: number): number {
	let result = (16 * ver + 128) * ver + 64;
	if (ver >= 2) {
		const numAlign = Math.floor(ver / 7) + 2;
		result -= (25 * numAlign - 10) * numAlign - 55;
		if (ver >= 7) result -= 36;
	}
	return result;
}

function getNumDataCodewords(ver: number, ecl: QrEcc): number {
	const o = ECC_ORDINAL[ecl];
	return (
		Math.floor(getNumRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[o][ver] * NUM_ERROR_CORRECTION_BLOCKS[o][ver]
	);
}

function reedSolomonMultiply(x: number, y: number): number {
	// Russian peasant multiplication in GF(2^8/0x11D)
	let z = 0;
	for (let i = 7; i >= 0; i--) {
		z = (z << 1) ^ ((z >>> 7) * 0x11d);
		z ^= ((y >>> i) & 1) * x;
	}
	return z;
}

function reedSolomonComputeDivisor(degree: number): number[] {
	const result: number[] = [];
	for (let i = 0; i < degree - 1; i++) result.push(0);
	result.push(1); // Start off with the monomial x^0
	let root = 1;
	for (let i = 0; i < degree; i++) {
		for (let j = 0; j < result.length; j++) {
			result[j] = reedSolomonMultiply(result[j], root);
			if (j + 1 < result.length) result[j] ^= result[j + 1];
		}
		root = reedSolomonMultiply(root, 0x02);
	}
	return result;
}

function reedSolomonComputeRemainder(data: readonly number[], divisor: readonly number[]): number[] {
	const result = divisor.map(() => 0);
	for (const b of data) {
		const factor = b ^ (result.shift() as number);
		result.push(0);
		divisor.forEach((coef, i) => {
			result[i] ^= reedSolomonMultiply(coef, factor);
		});
	}
	return result;
}

/**
 * An immutable square grid of dark and light modules. Create one with `QrCode.encodeText()` or
 * `QrCode.encodeBinary()`.
 */
export class QrCode {
	/** Version number, 1..40. */
	readonly version: number;
	/** Width and height in modules (version * 4 + 17). */
	readonly size: number;
	readonly errorCorrectionLevel: QrEcc;
	/** Mask pattern 0..7 actually used. */
	readonly mask: number;

	private readonly modules: boolean[][] = [];
	private isFunction: boolean[][] = [];

	/** Encode text as UTF-8 bytes in byte mode, in the smallest version that fits. */
	static encodeText(text: string, ecl: QrEcc = "M"): QrCode {
		return QrCode.encodeBinary(new TextEncoder().encode(text), ecl);
	}

	/**
	 * Encode bytes in byte mode, using the smallest version that fits at `ecl`. The ECC level is
	 * raised (never lowered) when the data still fits in that same version, so size never grows.
	 */
	static encodeBinary(data: Uint8Array | readonly number[], ecl: QrEcc = "M"): QrCode {
		const bytes = Array.from(data);
		let version = MIN_VERSION;
		let dataUsedBits = 0;
		for (; ; version++) {
			const capacityBits = getNumDataCodewords(version, ecl) * 8;
			const countBits = byteModeCountBits(version);
			const usedBits = bytes.length >= 1 << countBits ? Number.POSITIVE_INFINITY : 4 + countBits + bytes.length * 8;
			if (usedBits <= capacityBits) {
				dataUsedBits = usedBits;
				break;
			}
			if (version >= MAX_VERSION) throw new RangeError("Data too long for a QR code");
		}
		for (const boosted of ["M", "Q", "H"] as const) {
			if (ECC_ORDINAL[boosted] > ECC_ORDINAL[ecl] && dataUsedBits <= getNumDataCodewords(version, boosted) * 8) {
				ecl = boosted;
			}
		}

		const bb: number[] = [];
		appendBits(0x4, 4, bb); // byte mode indicator
		appendBits(bytes.length, byteModeCountBits(version), bb);
		for (const b of bytes) appendBits(b, 8, bb);

		const capacityBits = getNumDataCodewords(version, ecl) * 8;
		appendBits(0, Math.min(4, capacityBits - bb.length), bb); // terminator
		appendBits(0, (8 - (bb.length % 8)) % 8, bb);
		for (let padByte = 0xec; bb.length < capacityBits; padByte ^= 0xec ^ 0x11) appendBits(padByte, 8, bb);

		const dataCodewords: number[] = [];
		while (dataCodewords.length * 8 < bb.length) dataCodewords.push(0);
		bb.forEach((b, i) => {
			dataCodewords[i >>> 3] |= b << (7 - (i & 7));
		});
		return new QrCode(version, ecl, dataCodewords, -1);
	}

	private constructor(version: number, ecl: QrEcc, dataCodewords: readonly number[], mask: number) {
		if (version < MIN_VERSION || version > MAX_VERSION) throw new RangeError("Version value out of range");
		if (mask < -1 || mask > 7) throw new RangeError("Mask value out of range");
		this.version = version;
		this.errorCorrectionLevel = ecl;
		this.size = version * 4 + 17;

		const row: boolean[] = [];
		for (let i = 0; i < this.size; i++) row.push(false);
		for (let i = 0; i < this.size; i++) {
			this.modules.push(row.slice());
			this.isFunction.push(row.slice());
		}

		this.drawFunctionPatterns();
		this.drawCodewords(this.addEccAndInterleave(dataCodewords));

		if (mask === -1) {
			let minPenalty = 1_000_000_000;
			for (let i = 0; i < 8; i++) {
				this.applyMask(i);
				this.drawFormatBits(i);
				const penalty = this.getPenaltyScore();
				if (penalty < minPenalty) {
					mask = i;
					minPenalty = penalty;
				}
				this.applyMask(i); // XOR undoes the mask
			}
		}
		this.mask = mask;
		this.applyMask(mask);
		this.drawFormatBits(mask);
		this.isFunction = [];
	}

	/** True for a dark module; false for light or out of bounds. */
	getModule(x: number, y: number): boolean {
		return x >= 0 && x < this.size && y >= 0 && y < this.size && this.modules[y][x];
	}

	private drawFunctionPatterns(): void {
		for (let i = 0; i < this.size; i++) {
			this.setFunctionModule(6, i, i % 2 === 0);
			this.setFunctionModule(i, 6, i % 2 === 0);
		}
		this.drawFinderPattern(3, 3);
		this.drawFinderPattern(this.size - 4, 3);
		this.drawFinderPattern(3, this.size - 4);

		const alignPatPos = this.getAlignmentPatternPositions();
		const numAlign = alignPatPos.length;
		for (let i = 0; i < numAlign; i++) {
			for (let j = 0; j < numAlign; j++) {
				const onFinder = (i === 0 && j === 0) || (i === 0 && j === numAlign - 1) || (i === numAlign - 1 && j === 0);
				if (!onFinder) this.drawAlignmentPattern(alignPatPos[i], alignPatPos[j]);
			}
		}
		this.drawFormatBits(0); // dummy, overwritten after masking
		this.drawVersion();
	}

	private drawFormatBits(mask: number): void {
		const data = (ECC_FORMAT_BITS[this.errorCorrectionLevel] << 3) | mask;
		let rem = data;
		for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
		const bits = ((data << 10) | rem) ^ 0x5412;

		for (let i = 0; i <= 5; i++) this.setFunctionModule(8, i, getBit(bits, i));
		this.setFunctionModule(8, 7, getBit(bits, 6));
		this.setFunctionModule(8, 8, getBit(bits, 7));
		this.setFunctionModule(7, 8, getBit(bits, 8));
		for (let i = 9; i < 15; i++) this.setFunctionModule(14 - i, 8, getBit(bits, i));

		for (let i = 0; i < 8; i++) this.setFunctionModule(this.size - 1 - i, 8, getBit(bits, i));
		for (let i = 8; i < 15; i++) this.setFunctionModule(8, this.size - 15 + i, getBit(bits, i));
		this.setFunctionModule(8, this.size - 8, true); // always dark
	}

	private drawVersion(): void {
		if (this.version < 7) return;
		let rem = this.version;
		for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
		const bits = (this.version << 12) | rem;
		for (let i = 0; i < 18; i++) {
			const color = getBit(bits, i);
			const a = this.size - 11 + (i % 3);
			const b = Math.floor(i / 3);
			this.setFunctionModule(a, b, color);
			this.setFunctionModule(b, a, color);
		}
	}

	private drawFinderPattern(x: number, y: number): void {
		for (let dy = -4; dy <= 4; dy++) {
			for (let dx = -4; dx <= 4; dx++) {
				const dist = Math.max(Math.abs(dx), Math.abs(dy));
				const xx = x + dx;
				const yy = y + dy;
				if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) {
					this.setFunctionModule(xx, yy, dist !== 2 && dist !== 4);
				}
			}
		}
	}

	private drawAlignmentPattern(x: number, y: number): void {
		for (let dy = -2; dy <= 2; dy++) {
			for (let dx = -2; dx <= 2; dx++) {
				this.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
			}
		}
	}

	private setFunctionModule(x: number, y: number, isDark: boolean): void {
		this.modules[y][x] = isDark;
		this.isFunction[y][x] = true;
	}

	private addEccAndInterleave(data: readonly number[]): number[] {
		const ver = this.version;
		const o = ECC_ORDINAL[this.errorCorrectionLevel];
		if (data.length !== getNumDataCodewords(ver, this.errorCorrectionLevel)) throw new RangeError("Invalid argument");

		const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[o][ver];
		const blockEccLen = ECC_CODEWORDS_PER_BLOCK[o][ver];
		const rawCodewords = Math.floor(getNumRawDataModules(ver) / 8);
		const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
		const shortBlockLen = Math.floor(rawCodewords / numBlocks);

		const blocks: number[][] = [];
		const rsDiv = reedSolomonComputeDivisor(blockEccLen);
		for (let i = 0, k = 0; i < numBlocks; i++) {
			const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
			k += dat.length;
			const ecc = reedSolomonComputeRemainder(dat, rsDiv);
			if (i < numShortBlocks) dat.push(0);
			blocks.push(dat.concat(ecc));
		}

		const result: number[] = [];
		for (let i = 0; i < blocks[0].length; i++) {
			blocks.forEach((block, j) => {
				// Skip the padding byte in short blocks
				if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
			});
		}
		return result;
	}

	private drawCodewords(data: readonly number[]): void {
		if (data.length !== Math.floor(getNumRawDataModules(this.version) / 8)) throw new RangeError("Invalid argument");
		let i = 0;
		for (let right = this.size - 1; right >= 1; right -= 2) {
			if (right === 6) right = 5;
			for (let vert = 0; vert < this.size; vert++) {
				for (let j = 0; j < 2; j++) {
					const x = right - j;
					const upward = ((right + 1) & 2) === 0;
					const y = upward ? this.size - 1 - vert : vert;
					if (!this.isFunction[y][x] && i < data.length * 8) {
						this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
						i++;
					}
				}
			}
		}
	}

	private applyMask(mask: number): void {
		for (let y = 0; y < this.size; y++) {
			for (let x = 0; x < this.size; x++) {
				let invert: boolean;
				switch (mask) {
					case 0:
						invert = (x + y) % 2 === 0;
						break;
					case 1:
						invert = y % 2 === 0;
						break;
					case 2:
						invert = x % 3 === 0;
						break;
					case 3:
						invert = (x + y) % 3 === 0;
						break;
					case 4:
						invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
						break;
					case 5:
						invert = ((x * y) % 2) + ((x * y) % 3) === 0;
						break;
					case 6:
						invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
						break;
					case 7:
						invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
						break;
					default:
						throw new Error("Unreachable");
				}
				if (!this.isFunction[y][x] && invert) this.modules[y][x] = !this.modules[y][x];
			}
		}
	}

	private getPenaltyScore(): number {
		let result = 0;
		const size = this.size;

		for (let y = 0; y < size; y++) {
			let runColor = false;
			let runX = 0;
			const runHistory = [0, 0, 0, 0, 0, 0, 0];
			for (let x = 0; x < size; x++) {
				if (this.modules[y][x] === runColor) {
					runX++;
					if (runX === 5) result += PENALTY_N1;
					else if (runX > 5) result++;
				} else {
					this.finderPenaltyAddHistory(runX, runHistory);
					if (!runColor) result += this.finderPenaltyCountPatterns(runHistory) * PENALTY_N3;
					runColor = this.modules[y][x];
					runX = 1;
				}
			}
			result += this.finderPenaltyTerminateAndCount(runColor, runX, runHistory) * PENALTY_N3;
		}

		for (let x = 0; x < size; x++) {
			let runColor = false;
			let runY = 0;
			const runHistory = [0, 0, 0, 0, 0, 0, 0];
			for (let y = 0; y < size; y++) {
				if (this.modules[y][x] === runColor) {
					runY++;
					if (runY === 5) result += PENALTY_N1;
					else if (runY > 5) result++;
				} else {
					this.finderPenaltyAddHistory(runY, runHistory);
					if (!runColor) result += this.finderPenaltyCountPatterns(runHistory) * PENALTY_N3;
					runColor = this.modules[y][x];
					runY = 1;
				}
			}
			result += this.finderPenaltyTerminateAndCount(runColor, runY, runHistory) * PENALTY_N3;
		}

		for (let y = 0; y < size - 1; y++) {
			for (let x = 0; x < size - 1; x++) {
				const color = this.modules[y][x];
				if (
					color === this.modules[y][x + 1] &&
					color === this.modules[y + 1][x] &&
					color === this.modules[y + 1][x + 1]
				) {
					result += PENALTY_N2;
				}
			}
		}

		let dark = 0;
		for (const row of this.modules) dark = row.reduce((sum, color) => sum + (color ? 1 : 0), dark);
		const total = size * size;
		const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
		result += k * PENALTY_N4;
		return result;
	}

	private getAlignmentPatternPositions(): number[] {
		if (this.version === 1) return [];
		const numAlign = Math.floor(this.version / 7) + 2;
		const step = Math.floor((this.version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
		const result = [6];
		for (let pos = this.size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
		return result;
	}

	private finderPenaltyCountPatterns(runHistory: readonly number[]): number {
		const n = runHistory[1];
		const core =
			n > 0 && runHistory[2] === n && runHistory[3] === n * 3 && runHistory[4] === n && runHistory[5] === n;
		return (
			(core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0) +
			(core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0)
		);
	}

	private finderPenaltyTerminateAndCount(
		currentRunColor: boolean,
		currentRunLength: number,
		runHistory: number[],
	): number {
		if (currentRunColor) {
			this.finderPenaltyAddHistory(currentRunLength, runHistory);
			currentRunLength = 0;
		}
		currentRunLength += this.size; // light border after the final run
		this.finderPenaltyAddHistory(currentRunLength, runHistory);
		return this.finderPenaltyCountPatterns(runHistory);
	}

	private finderPenaltyAddHistory(currentRunLength: number, runHistory: number[]): void {
		if (runHistory[0] === 0) currentRunLength += this.size; // light border before the first run
		runHistory.pop();
		runHistory.unshift(currentRunLength);
	}
}
