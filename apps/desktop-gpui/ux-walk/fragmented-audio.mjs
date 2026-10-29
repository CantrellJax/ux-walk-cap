import fs from "node:fs";
import { MAX_OBJECT_BYTES } from "./checkpoint-store.mjs";

function boxes(bytes, start = 0, end = bytes.length) {
	const result = [];
	for (let cursor = start; cursor + 8 <= end; ) {
		let size = bytes.readUInt32BE(cursor);
		let header = 8;
		if (size === 1) {
			if (cursor + 16 > end) break;
			size = Number(bytes.readBigUInt64BE(cursor + 8));
			header = 16;
		}
		if (!Number.isSafeInteger(size) || size < header || cursor + size > end)
			break;
		result.push({
			kind: bytes.toString("ascii", cursor + 4, cursor + 8),
			start: cursor,
			end: cursor + size,
			payload: bytes.subarray(cursor + header, cursor + size),
		});
		cursor += size;
	}
	return result;
}
function nested(bytes, names) {
	if (!names.length) return bytes;
	for (const box of boxes(bytes))
		if (box.kind === names[0]) {
			const found = nested(box.payload, names.slice(1));
			if (found) return found;
		}
	return null;
}
function timing(init, moof) {
	const mdhd = nested(init, ["moov", "trak", "mdia", "mdhd"]);
	const trex = nested(init, ["moov", "mvex", "trex"]);
	if (!mdhd || !trex)
		throw new Error("Audio fragment initialization is incomplete");
	const rate = mdhd.readUInt32BE(mdhd[0] === 1 ? 20 : 12);
	const traf = nested(moof, ["moof", "traf"]);
	const tfhd = nested(traf, ["tfhd"]);
	const tfdt = nested(traf, ["tfdt"]);
	if (!rate || !tfhd || !tfdt)
		throw new Error("Audio fragment clock is unavailable");
	const flags = tfhd.readUInt32BE(0) & 0xffffff;
	if (flags & 1)
		throw new Error("Absolute-offset audio fragments are unsupported");
	let position = 8;
	if (flags & 2) position += 4;
	const defaultDuration =
		flags & 8 ? tfhd.readUInt32BE(position) : trex.readUInt32BE(12);
	const start =
		tfdt[0] === 1 ? Number(tfdt.readBigUInt64BE(4)) : tfdt.readUInt32BE(4);
	let duration = 0;
	for (const trun of boxes(traf)
		.filter((box) => box.kind === "trun")
		.map((box) => box.payload)) {
		const flags = trun.readUInt32BE(0) & 0xffffff;
		const count = trun.readUInt32BE(4);
		if (count > 1_000_000)
			throw new Error("Audio fragment sample count is invalid");
		let cursor = 8 + (flags & 1 ? 4 : 0) + (flags & 4 ? 4 : 0);
		for (let sample = 0; sample < count; sample++) {
			duration += flags & 0x100 ? trun.readUInt32BE(cursor) : defaultDuration;
			if (flags & 0x100) cursor += 4;
			if (flags & 0x200) cursor += 4;
			if (flags & 0x400) cursor += 4;
			if (flags & 0x800) {
				if (trun.readInt32BE(cursor) !== 0)
					throw new Error(
						"Audio composition offsets require explicit presentation-clock handling",
					);
				cursor += 4;
			}
		}
	}
	if (!(duration > 0) || !Number.isSafeInteger(start + duration))
		throw new Error("Audio fragment duration is invalid");
	return {
		startMs: (start * 1000) / rate,
		endMs: ((start + duration) * 1000) / rate,
		startTick: start,
		endTick: start + duration,
		timescale: rate,
	};
}

export function scanFragmentedAudio(
	file,
	{ cursor = 0, init, maxBytes = MAX_OBJECT_BYTES } = {},
) {
	const fd = fs.openSync(file, "r");
	try {
		fs.fsyncSync(fd);
		const size = fs.fstatSync(fd).size;
		if (cursor > size)
			throw new Error("Growing audio was replaced or truncated");
		const read = (start, length) => {
			const bytes = Buffer.alloc(length);
			if (fs.readSync(fd, bytes, 0, length, start) !== length)
				throw new Error("Audio changed while reading its complete prefix");
			return bytes;
		};
		const initial = [];
		const fragments = [];
		let position = cursor;
		let end = cursor;
		let fragmentStart = null;
		let moof = null;
		let consumed = 0;
		while (position + 8 <= size) {
			const header = read(position, Math.min(16, size - position));
			let length = header.readUInt32BE(0);
			const type = header.toString("ascii", 4, 8);
			if (length === 1) {
				if (header.length < 16) break;
				length = Number(header.readBigUInt64BE(8));
			}
			if (
				!Number.isSafeInteger(length) ||
				length < 8 ||
				position + length > size
			)
				break;
			if (["ftyp", "moov"].includes(type) && !init) {
				if (length > MAX_OBJECT_BYTES)
					throw new Error("Audio initialization exceeds checkpoint budget");
				initial.push(read(position, length));
				end = position + length;
			} else if (type === "moof") {
				if (length > MAX_OBJECT_BYTES)
					throw new Error("Audio fragment exceeds checkpoint budget");
				fragmentStart = position;
				moof = read(position, length);
			} else if (type === "mdat" && fragmentStart != null) {
				const fragmentLength = position + length - fragmentStart;
				if (fragmentLength > maxBytes)
					throw new Error("Audio fragment exceeds checkpoint budget");
				if (consumed + fragmentLength > maxBytes) break;
				const bytes = read(fragmentStart, fragmentLength);
				const initialization = init ?? Buffer.concat(initial);
				fragments.push({
					start: fragmentStart,
					end: fragmentStart + fragmentLength,
					bytes,
					...timing(initialization, moof),
				});
				consumed += fragmentLength;
				end = fragmentStart + fragmentLength;
				fragmentStart = null;
			} else if (type === "mdat" && !init)
				throw new Error(
					"Live audio does not expose complete fragmented packets",
				);
			position += length;
		}
		const initialization = init ?? Buffer.concat(initial);
		return { init: initialization, fragments, end };
	} finally {
		fs.closeSync(fd);
	}
}
