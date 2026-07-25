codeunit 50960 "Parameter Records"
{
    procedure FillBuffer(var TempBuffer: Record "Sales Line" temporary; var SourceLine: Record "Sales Line")
    begin
        // TempBuffer is an in-memory buffer the CALLER owns. Its temp-ness is
        // declared on the parameter, not in a var section, so a var-section-only
        // scan cannot see it and every Insert here reads as a SQL INSERT.
        if SourceLine.FindSet() then
            repeat
                TempBuffer.Init();
                TempBuffer.TransferFields(SourceLine);
                TempBuffer.Insert();
            until SourceLine.Next() = 0;
    end;

    procedure FilterParameterRecord(var KeyTest: Record "Key Test Table")
    begin
        // Resolving the parameter's table is what lets unindexed-filter check
        // this filter against the table's keys at all.
        KeyTest.SetRange(Description, 'Test');
        if KeyTest.FindFirst() then
            Message(KeyTest."No.");
    end;

    procedure InsertIntoRealParameterRecord(var SalesLine: Record "Sales Line"; var SourceLine: Record "Sales Line")
    begin
        // Not temporary: these inserts really do hit the database, one per row.
        if SourceLine.FindSet() then
            repeat
                SalesLine.Init();
                SalesLine.Insert();
            until SourceLine.Next() = 0;
    end;
}
