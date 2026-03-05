/**
 * Protobuf Encoding Utilities
 * Based on yet-another-opencode-cursor-auth/src/lib/api/proto/encoding.ts
 */

/**
 * Encode a varint
 */
function encodeVarint(value) {
  const bytes = [];
  let v = BigInt(value);
  while (v > 127n) {
    bytes.push(Number((v & 0x7Fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

/**
 * Encode a field tag
 */
function encodeTag(fieldNumber, wireType) {
  return encodeVarint((fieldNumber << 3) | wireType);
}

/**
 * Encode a string field
 */
function encodeStringField(fieldNumber, value) {
  const tag = encodeTag(fieldNumber, 2); // wireType 2 = length-delimited
  const data = Buffer.from(String(value ?? ''), 'utf-8');
  const length = encodeVarint(data.length);
  return Buffer.concat([tag, length, data]);
}

/**
 * Encode a bytes field
 */
function encodeBytesField(fieldNumber, value) {
  const tag = encodeTag(fieldNumber, 2);
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const length = encodeVarint(data.length);
  return Buffer.concat([tag, length, data]);
}

/**
 * Encode a message field (nested message)
 */
function encodeMessageField(fieldNumber, value) {
  return encodeBytesField(fieldNumber, value);
}

/**
 * Encode a uint32 field
 */
function encodeUint32Field(fieldNumber, value) {
  const tag = encodeTag(fieldNumber, 0); // wireType 0 = varint
  const data = encodeVarint(value ?? 0);
  return Buffer.concat([tag, data]);
}

/**
 * Encode an int32 field
 */
function encodeInt32Field(fieldNumber, value) {
  return encodeUint32Field(fieldNumber, value);
}

/**
 * Encode an int64 field
 */
function encodeInt64Field(fieldNumber, value) {
  const tag = encodeTag(fieldNumber, 0);
  const data = encodeVarint(BigInt(value ?? 0));
  return Buffer.concat([tag, data]);
}

/**
 * Encode a bool field
 */
function encodeBoolField(fieldNumber, value) {
  return encodeUint32Field(fieldNumber, value ? 1 : 0);
}

/**
 * Concatenate multiple buffers
 */
function concatBytes(...buffers) {
  return Buffer.concat(buffers.filter(b => b && b.length > 0));
}

/**
 * Add Connect/gRPC-Web envelope to a message
 * Format: [flags:1byte][length:4bytes BE][data]
 */
function addConnectEnvelope(data, compressed = false) {
  const flags = compressed ? 1 : 0;
  const length = data.length;
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(length, 1);
  return Buffer.concat([header, data]);
}

/**
 * Encode a protobuf Value (for Struct fields)
 * Value is a oneof: null_value, number_value, string_value, bool_value, struct_value, list_value
 * Field numbers: 1=null, 2=number, 3=string, 4=bool, 5=struct, 6=list
 */
function encodeProtobufValue(value) {
  if (value === null || value === undefined) {
    // null_value (field 1, wire type 0) = NullValue.NULL_VALUE (0)
    const tag = encodeTag(1, 0);
    const data = encodeVarint(0);
    return Buffer.concat([tag, data]);
  }
  
  if (typeof value === 'boolean') {
    // bool_value (field 4)
    const tag = encodeTag(4, 0);
    const data = encodeVarint(value ? 1 : 0);
    return Buffer.concat([tag, data]);
  }
  
  if (typeof value === 'number') {
    // number_value (field 2) - encoded as double (wire type 1, fixed64)
    const tag = encodeTag(2, 1);
    const buffer = Buffer.allocUnsafe(8);
    buffer.writeDoubleLE(value, 0);
    return Buffer.concat([tag, buffer]);
  }
  
  if (typeof value === 'string') {
    // string_value (field 3)
    return encodeStringField(3, value);
  }
  
  if (Array.isArray(value)) {
    // list_value (field 6) → ListValue { repeated Value values = 1 }
    // Each element must be its OWN field 1 entry (repeated field encoding).
    const encodedValues = value.map(v => encodeMessageField(1, encodeProtobufValue(v)));
    const listData = concatBytes(...encodedValues);
    return encodeMessageField(6, listData);
  }
  
  if (typeof value === 'object') {
    // struct_value (field 5)
    const structData = encodeProtobufStruct(value);
    return encodeMessageField(5, structData);
  }
  
  // Default to string
  return encodeStringField(3, String(value));
}

/**
 * Encode a protobuf Struct
 * Struct is map<string, Value> - encoded as repeated Struct.FieldsEntry (field 1)
 * Each FieldsEntry has: key (field 1, string), value (field 2, Value)
 */
function encodeProtobufStruct(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return Buffer.alloc(0);
  }
  
  const entries = [];
  for (const [key, val] of Object.entries(obj)) {
    // Each entry: key (field 1), value (field 2)
    const keyField = encodeStringField(1, key);
    const valueField = encodeMessageField(2, encodeProtobufValue(val));
    const entry = concatBytes(keyField, valueField);
    entries.push(encodeMessageField(1, entry));
  }
  
  return concatBytes(...entries);
}

/**
 * Decode a varint from a buffer at the given position.
 * Returns [value, newPos].
 */
function _decodeVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result >>> 0, pos];
    shift += 7;
    if (shift > 35) break;
  }
  return [result >>> 0, pos];
}

/**
 * Parse protobuf fields from a buffer (minimal parser for decode).
 * Returns array of { fieldNumber, wireType, value }.
 */
function _parseFields(buf) {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    const [tag, p1] = _decodeVarint(buf, pos);
    if (p1 >= buf.length && tag === 0) break;
    const wireType = tag & 0x07;
    const fieldNumber = tag >>> 3;
    if (fieldNumber === 0) break;
    pos = p1;

    if (wireType === 0) {
      const [val, p2] = _decodeVarint(buf, pos);
      fields.push({ fieldNumber, wireType, value: val });
      pos = p2;
    } else if (wireType === 2) {
      const [len, p2] = _decodeVarint(buf, pos);
      const data = buf.subarray(p2, p2 + len);
      fields.push({ fieldNumber, wireType, value: data });
      pos = p2 + len;
    } else if (wireType === 1) {
      // 64-bit (double)
      const data = buf.subarray(pos, pos + 8);
      fields.push({ fieldNumber, wireType, value: data });
      pos += 8;
    } else if (wireType === 5) {
      // 32-bit (float)
      const data = buf.subarray(pos, pos + 4);
      fields.push({ fieldNumber, wireType, value: data });
      pos += 4;
    } else {
      break;
    }
  }
  return fields;
}

/**
 * Decode a google.protobuf.Value from protobuf bytes.
 * Value oneof: { null_value=1, number_value=2, string_value=3, bool_value=4, struct_value=5, list_value=6 }
 */
function decodeProtobufValue(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return null;
  const fields = _parseFields(buf);
  for (const f of fields) {
    switch (f.fieldNumber) {
      case 1: // null_value (NullValue enum)
        return null;
      case 2: // number_value (double, wire type 1 = 64-bit)
        if (f.wireType === 1 && Buffer.isBuffer(f.value) && f.value.length === 8) {
          return f.value.readDoubleLE(0);
        }
        if (f.wireType === 0) return Number(f.value);
        return 0;
      case 3: // string_value
        return Buffer.isBuffer(f.value) ? f.value.toString('utf-8') : String(f.value);
      case 4: // bool_value
        return f.wireType === 0 ? Boolean(f.value) : true;
      case 5: // struct_value
        return Buffer.isBuffer(f.value) ? decodeProtobufStruct(f.value) : {};
      case 6: // list_value
        return Buffer.isBuffer(f.value) ? _decodeListValue(f.value) : [];
    }
  }
  return null;
}

/**
 * Decode a google.protobuf.ListValue from protobuf bytes.
 * ListValue: { repeated Value values = 1; }
 */
function _decodeListValue(buf) {
  const fields = _parseFields(buf);
  const result = [];
  for (const f of fields) {
    if (f.fieldNumber === 1 && Buffer.isBuffer(f.value)) {
      result.push(decodeProtobufValue(f.value));
    }
  }
  return result;
}

/**
 * Decode a google.protobuf.Struct from protobuf bytes.
 * Struct: { map<string, Value> fields = 1; }
 * Wire format: repeated MapEntry { string key = 1; Value value = 2; }
 *
 * Also handles multiple field-2 buffers concatenated (from repeated field parsing).
 */
function decodeProtobufStruct(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return {};
  const result = {};
  const fields = _parseFields(buf);
  for (const f of fields) {
    if (f.fieldNumber === 1 && f.wireType === 2 && Buffer.isBuffer(f.value)) {
      const entryFields = _parseFields(f.value);
      let key = null;
      let val = null;
      for (const ef of entryFields) {
        if (ef.fieldNumber === 1 && Buffer.isBuffer(ef.value)) {
          key = ef.value.toString('utf-8');
        } else if (ef.fieldNumber === 2 && Buffer.isBuffer(ef.value)) {
          val = decodeProtobufValue(ef.value);
        }
      }
      if (key !== null) {
        result[key] = val;
      }
    }
  }
  return result;
}

/**
 * Decode a google.protobuf.Struct from raw McpArgs field 2 buffers.
 * In McpArgs, field 2 is repeated (one per map entry), not a single Struct message.
 * Each field 2 buffer is a MapEntry { string key = 1; Value value = 2; }.
 */
function decodeProtobufStructFromRepeatedEntries(entryBuffers) {
  const result = {};
  for (const buf of entryBuffers) {
    if (!Buffer.isBuffer(buf) || buf.length === 0) continue;
    const entryFields = _parseFields(buf);
    let key = null;
    let val = null;
    for (const ef of entryFields) {
      if (ef.fieldNumber === 1 && Buffer.isBuffer(ef.value)) {
        key = ef.value.toString('utf-8');
      } else if (ef.fieldNumber === 2 && Buffer.isBuffer(ef.value)) {
        val = decodeProtobufValue(ef.value);
      }
    }
    if (key !== null) {
      result[key] = val;
    }
  }
  return result;
}

module.exports = {
  encodeVarint,
  encodeTag,
  encodeStringField,
  encodeBytesField,
  encodeMessageField,
  encodeUint32Field,
  encodeInt32Field,
  encodeInt64Field,
  encodeBoolField,
  concatBytes,
  addConnectEnvelope,
  encodeProtobufValue,
  encodeProtobufStruct,
  decodeProtobufValue,
  decodeProtobufStruct,
  decodeProtobufStructFromRepeatedEntries,
};
