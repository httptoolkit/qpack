export interface HeaderField {
    name: string;
    value: string;

    /**
     * Marks a field as carrying sensitive data (RFC 9204 s7.1). When
     * encoding, such fields are never added to the dynamic table and are
     * sent as never-indexed literals; when decoding, fields the peer sent
     * never-indexed have this set to true (and it is omitted otherwise).
     * An intermediary re-encoding received fields preserves the marker by
     * passing decoded fields back to an encoder as-is.
     */
    sensitive?: boolean;
}
