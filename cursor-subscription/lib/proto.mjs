/**
 * Wire codecs for Cursor's Agent protocol.
 *
 * Two layers live here because they are the same concern — turning Cursor's
 * bytes into something usable:
 *
 *   1. A minimal protobuf reader/writer. Only the subset the Cursor Agent
 *      protocol needs: varints, length-delimited fields, fixed64 doubles and
 *      nested messages. Map fields are encoded as repeated entry messages,
 *      exactly like the official protobuf runtime.
 *   2. Connect framing, the envelope protobuf-over-HTTP/2 uses. Each frame is
 *      `[1 byte flags][4 byte big-endian length][payload]`.
 *
 * Ported from `dsh-cursor-subscription` (MIT, orrinzeng) — see NOTICE.md.
 *
 * @module cursor-subscription/proto
 */

// ---------------------------------------------------------------------------
// Protobuf primitives
// ---------------------------------------------------------------------------

/** Encode one unsigned varint into a Uint8Array. */
export function varintEncode(value) {
	const out = [];
	let n = Math.trunc(value);
	while (n > 0x7f) {
		out.push((n & 0x7f) | 0x80);
		n = Math.floor(n / 128);
	}
	out.push(n);
	return Uint8Array.from(out);
}

/** Combine byte arrays into one. */
export function concatBytes(parts) {
	let total = 0;
	for (const part of parts) total += part.length;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

/** A streaming protobuf message writer. */
export class Writer {
	constructor() {
		this.parts = [];
	}

	/** Append a raw field tag. */
	tag(field, wireType) {
		this.parts.push(varintEncode((field << 3) | wireType));
		return this;
	}

	/** Append a length-delimited payload. */
	bytes(field, data) {
		this.tag(field, 2);
		this.parts.push(varintEncode(data.length));
		this.parts.push(data);
		return this;
	}

	/** Append a UTF-8 string field. */
	string(field, value) {
		return this.bytes(field, new TextEncoder().encode(value));
	}

	/** Append a nested message field. */
	message(field, inner) {
		return this.bytes(field, inner);
	}

	/** Append a varint field (uint32/int32/bool/enum). */
	varint(field, value) {
		this.tag(field, 0);
		this.parts.push(varintEncode(Math.trunc(value)));
		return this;
	}

	/** Append a double (fixed64, little-endian) field. */
	double(field, value) {
		this.tag(field, 1);
		const buffer = new ArrayBuffer(8);
		new DataView(buffer).setFloat64(0, value, true);
		this.parts.push(new Uint8Array(buffer));
		return this;
	}

	finish() {
		return concatBytes(this.parts);
	}
}

/** A streaming protobuf message reader. */
export class Reader {
	constructor(bytes) {
		this.data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
		this.pos = 0;
	}

	get done() {
		return this.pos >= this.data.length;
	}

	varint() {
		let result = 0;
		let shift = 0;
		for (;;) {
			if (this.pos >= this.data.length) throw new Error("protobuf: truncated varint");
			const byte = this.data[this.pos++];
			result += (byte & 0x7f) * 2 ** shift;
			if ((byte & 0x80) === 0) break;
			shift += 7;
			if (shift > 63) throw new Error("protobuf: varint too long");
		}
		return result;
	}

	/** Read a tag and return `{ field, wireType }`. */
	tag() {
		const raw = this.varint();
		return { field: Math.floor(raw / 8), wireType: raw % 8 };
	}

	bytes() {
		const length = this.varint();
		if (this.pos + length > this.data.length) throw new Error("protobuf: truncated bytes");
		const out = this.data.subarray(this.pos, this.pos + length);
		this.pos += length;
		return out;
	}

	string() {
		return new TextDecoder().decode(this.bytes());
	}

	double() {
		if (this.pos + 8 > this.data.length) throw new Error("protobuf: truncated double");
		const view = new DataView(this.data.buffer, this.data.byteOffset + this.pos, 8);
		this.pos += 8;
		return view.getFloat64(0, true);
	}

	/** Skip a field of the given wire type. */
	skip(wireType) {
		if (wireType === 0) {
			this.varint();
		} else if (wireType === 1) {
			if (this.pos + 8 > this.data.length) throw new Error("protobuf: truncated fixed64");
			this.pos += 8;
		} else if (wireType === 2) {
			this.bytes();
		} else if (wireType === 5) {
			if (this.pos + 4 > this.data.length) throw new Error("protobuf: truncated fixed32");
			this.pos += 4;
		} else {
			throw new Error(`protobuf: unsupported wire type ${wireType}`);
		}
	}
}

/** Collect every field of a message as `{ field, wireType, value }`. */
export function readFields(bytes) {
	const reader = new Reader(bytes);
	const fields = [];
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		switch (wireType) {
			case 0:
				fields.push({ field, wireType, value: reader.varint() });
				break;
			case 1:
				fields.push({ field, wireType, value: reader.double() });
				break;
			case 2: {
				const data = reader.bytes();
				fields.push({ field, wireType, value: data, bytes: data });
				break;
			}
			case 5: {
				const data = new Reader(reader.data.subarray(reader.pos, reader.pos + 4)).varint();
				reader.pos += 4;
				fields.push({ field, wireType, value: data, bytes: undefined });
				break;
			}
			default:
				throw new Error(`protobuf: unsupported wire type ${wireType}`);
		}
	}
	return fields;
}

/** First field with the given number, or undefined. */
export function firstField(fields, field) {
	return fields.find((entry) => entry.field === field);
}

/** All fields with the given number. */
export function allFields(fields, field) {
	return fields.filter((entry) => entry.field === field);
}

// ---------------------------------------------------------------------------
// google.protobuf.Value — the shape Cursor uses for MCP tool schemas
// ---------------------------------------------------------------------------

/**
 * Encode a JSON value as `google.protobuf.Value`.
 * @param {unknown} value
 * @returns {Uint8Array}
 */
export function encodeValue(value) {
	const writer = new Writer();
	if (value === null || value === undefined) {
		writer.varint(1, 0); // null_value
	} else if (typeof value === "boolean") {
		writer.varint(4, value ? 1 : 0); // bool_value
	} else if (typeof value === "number") {
		writer.double(2, value); // number_value
	} else if (typeof value === "string") {
		writer.string(3, value); // string_value
	} else if (Array.isArray(value)) {
		const list = new Writer();
		for (const item of value) list.message(1, encodeValue(item)); // ListValue.values
		writer.message(6, list.finish()); // list_value
	} else if (typeof value === "object") {
		const struct = new Writer();
		for (const [key, item] of Object.entries(value)) {
			const entry = new Writer();
			entry.string(1, key); // Struct.FieldsEntry.key
			entry.message(2, encodeValue(item)); // Struct.FieldsEntry.value
			struct.message(1, entry.finish()); // Struct.fields
		}
		writer.message(5, struct.finish()); // struct_value
	} else {
		throw new Error(`cannot encode ${typeof value} as google.protobuf.Value`);
	}
	return writer.finish();
}

/**
 * Decode `google.protobuf.Value` bytes back into a JSON value.
 * @param {Uint8Array} bytes
 * @returns {unknown}
 */
export function decodeValue(bytes) {
	const reader = new Reader(bytes);
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 0) {
			reader.varint();
			return null;
		}
		if (field === 2 && wireType === 1) return reader.double();
		if (field === 3 && wireType === 2) return reader.string();
		if (field === 4 && wireType === 0) return reader.varint() !== 0;
		if (field === 5 && wireType === 2) return decodeStruct(reader.bytes());
		if (field === 6 && wireType === 2) return decodeList(reader.bytes());
		reader.skip(wireType);
	}
	return null;
}

function decodeStruct(bytes) {
	const reader = new Reader(bytes);
	const result = {};
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 2) {
			const entry = new Reader(reader.bytes());
			let key = "";
			let value = null;
			while (!entry.done) {
				const tag = entry.tag();
				if (tag.field === 1 && tag.wireType === 2) key = entry.string();
				else if (tag.field === 2 && tag.wireType === 2) value = decodeValue(entry.bytes());
				else entry.skip(tag.wireType);
			}
			result[key] = value;
		} else {
			reader.skip(wireType);
		}
	}
	return result;
}

function decodeList(bytes) {
	const reader = new Reader(bytes);
	const result = [];
	while (!reader.done) {
		const { field, wireType } = reader.tag();
		if (field === 1 && wireType === 2) result.push(decodeValue(reader.bytes()));
		else reader.skip(wireType);
	}
	return result;
}


// ---------------------------------------------------------------------------
// Connect framing
// ---------------------------------------------------------------------------

import { gunzipSync } from "node:zlib";

export const CONNECT_END_STREAM_FLAG = 0b00000010;
export const CONNECT_COMPRESSED_FLAG = 0b00000001;

/** Upper bound on a decompressed frame; guards against a zip bomb. */
export const MAX_CONNECT_FRAME_BYTES = 64 * 1024 * 1024;

/** Returned by `next({ timeoutMs })` when nothing arrived in time. */
export const TIMED_OUT = Symbol("connect-frame-timeout");

/** Wrap a payload in a Connect frame: `[1 byte flags][4 byte BE length][payload]`. */
export function frameEncode(payload, flags = 0) {
	const header = new Uint8Array(5);
	header[0] = flags;
	new DataView(header.buffer).setUint32(1, payload.length, false);
	return concatBytes([header, payload]);
}

/**
 * Incremental Connect frame parser fed by arbitrary response chunks.
 *
 * Backed by an explicit promise queue so a reader that stops mid-run (to answer
 * a tool call) can be resumed without losing already-buffered frames.
 */
export class ConnectFrameReader {
	/** Pending bytes, with an already-consumed prefix at `#off`. */
	#buf = new Uint8Array(0);
	#off = 0;
	/** Complete frames waiting to be read. */
	#queue = [];
	#waiter = null;
	#ended = false;
	#error = null;

	/** Feed the next chunk of the response body. */
	push(chunk) {
		if (chunk.length === 0) return;
		// Drop the consumed prefix first, so the buffer only ever holds bytes we
		// still need. That keeps repeated pushes linear instead of re-copying an
		// ever-growing prefix on every chunk.
		let base = this.#buf;
		if (this.#off > 0) {
			base = this.#buf.subarray(this.#off);
			this.#off = 0;
		}
		const next = new Uint8Array(base.length + chunk.length);
		next.set(base, 0);
		next.set(chunk, base.length);
		this.#buf = next;
		this.#drain();
	}

	/** Signal that the response body ended. */
	finish() {
		this.#ended = true;
		this.#settle();
	}

	/** Abort the stream with an error. */
	fail(error) {
		this.#error = error;
		this.#settle();
	}

	#settle() {
		const waiter = this.#waiter;
		if (!waiter) return;
		this.#waiter = null;
		if (waiter.timer) clearTimeout(waiter.timer);
		waiter.resolve();
	}

	#drain() {
		for (;;) {
			const available = this.#buf.length - this.#off;
			if (available < 5) break;
			const flags = this.#buf[this.#off];
			// The length is a 4-byte big-endian integer at offset 1 of the header.
			const length = new DataView(
				this.#buf.buffer,
				this.#buf.byteOffset + this.#off + 1,
				4,
			).getUint32(0, false);
			if (available < 5 + length) break; // body still arriving

			const raw = this.#buf.subarray(this.#off + 5, this.#off + 5 + length);
			this.#off += 5 + length;

			let payload = raw;
			if ((flags & CONNECT_COMPRESSED_FLAG) !== 0) {
				if (length > MAX_CONNECT_FRAME_BYTES) {
					this.#error = new Error("Cursor sent an oversized compressed frame");
					this.#settle();
					return;
				}
				try {
					payload = new Uint8Array(gunzipSync(raw));
				} catch (cause) {
					this.#error = new Error("Cursor sent an unreadable compressed frame", { cause });
					this.#settle();
					return;
				}
			}
			this.#queue.push({ flags, payload });
		}
		if (this.#queue.length > 0 || this.#ended || this.#error) this.#settle();
	}

	/**
	 * Await the next frame.
	 *
	 * @returns {Promise<{flags: number, payload: Uint8Array} | undefined>}
	 *   The frame, or `undefined` once the stream ended and the buffer drained.
	 * @throws the failure recorded by {@link fail} or by a malformed frame.
	 */
	async next(options = {}) {
		const { timeoutMs } = options;
		for (;;) {
			if (this.#error) {
				const error = this.#error;
				this.#error = null;
				throw error;
			}
			if (this.#queue.length > 0) return this.#queue.shift();
			if (this.#ended) return undefined;
			// The timeout lives in here, not in a Promise.race at the call site:
			// racing would abandon this pending waiter, so every timed-out read
			// would leak a promise that can never settle.
			const outcome = await new Promise((resolve) => {
				const waiter = { resolve, timer: null };
				if (timeoutMs !== undefined) {
					waiter.timer = setTimeout(() => {
						if (this.#waiter === waiter) this.#waiter = null;
						resolve(TIMED_OUT);
					}, timeoutMs);
				}
				this.#waiter = waiter;
			});
			if (outcome === TIMED_OUT) return TIMED_OUT;
		}
	}

	/** True when a whole frame is already buffered. */
	get hasBuffered() {
		return this.#queue.length > 0;
	}

	/** Number of complete frames waiting to be read. */
	get bufferedCount() {
		return this.#queue.length;
	}
}
