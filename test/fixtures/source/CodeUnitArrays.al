codeunit 50961 "Array Records"
{
    var
        "G/L Buffer": Record "Sales Line" temporary;

    procedure QuotedVariableNameInLoop(var SourceLine: Record "Sales Line")
    begin
        // A variable declared with a QUOTED name was dropped from the index
        // entirely — the name node is a quoted_identifier, not an identifier —
        // so every gate that resolves the receiver failed open on it, and this
        // in-memory buffer's Insert read as a SQL INSERT per row.
        if SourceLine.FindSet() then
            repeat
                "G/L Buffer".Init();
                "G/L Buffer".Insert();
            until SourceLine.Next() = 0;
    end;

    procedure InsertIntoTempArrayInLoop(var SourceLine: Record "Sales Line")
    var
        TempBuffer: array[5] of Record "Sales Line" temporary;
    begin
        // An array of TEMPORARY records is still in memory. Every element op
        // here is a buffer write, not a SQL INSERT — but the declared type is
        // `array[5] of Record ...`, so a scan that only looks for a direct
        // `record_type` child sees neither the table nor the `temporary`.
        if SourceLine.FindSet() then
            repeat
                TempBuffer[1].Init();
                TempBuffer[1].Insert();
            until SourceLine.Next() = 0;
    end;

    procedure InsertIntoRealArrayInLoop(var SourceLine: Record "Sales Line")
    var
        RealLine: array[5] of Record "Sales Line";
    begin
        // Not temporary: these inserts really do hit the database, one per row.
        if SourceLine.FindSet() then
            repeat
                RealLine[1].Init();
                RealLine[1].Insert();
            until SourceLine.Next() = 0;
    end;

    procedure JsonGetInLoop(Tokens: JsonArray)
    var
        Tok: JsonToken;
        Value: JsonToken;
        i: Integer;
    begin
        // `Tok.AsObject().Get(...)` has a CALL EXPRESSION as its receiver, not
        // a record variable — AL has no record-returning expression to chain a
        // Find/Get onto. It is a JsonObject lookup and costs no SQL at all.
        for i := 0 to 5 do begin
            Tokens.Get(i, Tok);
            if Tok.AsObject().Get('id', Value) then;
        end;
    end;
}
