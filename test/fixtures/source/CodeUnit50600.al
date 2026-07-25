codeunit 50600 "Filter Test"
{
    procedure FilterWithIndex()
    var
        KeyTest: Record "Key Test Table";
    begin
        KeyTest.SetRange("No.", 'TEST001');
        if KeyTest.FindFirst() then
            Message(KeyTest.Description);
    end;

    procedure FilterWithoutIndex()
    var
        KeyTest: Record "Key Test Table";
    begin
        KeyTest.SetRange(Description, 'Test');
        if KeyTest.FindFirst() then
            Message(KeyTest."No.");
    end;

    procedure FilterOnSecondaryKey()
    var
        KeyTest: Record "Key Test Table";
    begin
        KeyTest.SetRange("Customer No.", 'C001');
        if KeyTest.FindSet() then
            repeat
                // processed
            until KeyTest.Next() = 0;
    end;

    procedure FilterWithCoveringSibling()
    var
        KeyTest: Record "Key Test Table";
    begin
        // "Customer No." is the leading field of key CustomerDate, so SQL seeks
        // that key and Description is a residual predicate, not a table scan.
        KeyTest.SetRange("Customer No.", 'C001');
        KeyTest.SetRange(Description, 'Test');
        if KeyTest.FindSet() then
            repeat
                // processed
            until KeyTest.Next() = 0;
    end;

    procedure FilterWithSiblingOnOtherRecord()
    var
        KeyTest: Record "Key Test Table";
        OtherKeyTest: Record "Key Test Table";
    begin
        // The covering filter is on a different record variable, so it cannot
        // give KeyTest a seekable access path.
        OtherKeyTest.SetRange("No.", 'X001');
        KeyTest.SetRange(Description, 'Test');
        if KeyTest.FindFirst() then
            Message(KeyTest."No.");
    end;

    procedure SetLoadFieldsThenCallTableMethod()
    var
        KeyTest: Record "Key Test Table";
    begin
        // `KeyTest.HasRelatedEntries` is a paren-less PROCEDURE call on the
        // table, not a field read. Recorded as a field access, it made this
        // look like a SetLoadFields that forgot a field -- reported critical,
        // claiming runtime errors, about a method.
        KeyTest.SetLoadFields("No.");
        if KeyTest.FindSet() then
            repeat
                if KeyTest.HasRelatedEntries then
                    Message('%1', KeyTest."No.");
            until KeyTest.Next() = 0;
    end;

    procedure SetLoadFieldsMissingRealField()
    var
        KeyTest: Record "Key Test Table";
    begin
        // Description IS a field of Key Test Table, and it is not loaded.
        KeyTest.SetLoadFields("No.");
        if KeyTest.FindSet() then
            repeat
                Message('%1', KeyTest.Description);
            until KeyTest.Next() = 0;
    end;

    procedure SetLoadFieldsThenReadPrimaryKey()
    var
        KeyTest: Record "Key Test Table";
    begin
        // "No." is Key Test Table's PRIMARY key. BC always loads primary key
        // fields — SetLoadFields cannot exclude them, because they identify the
        // record. Reporting one as a forgotten field is a critical finding
        // about something that cannot happen.
        KeyTest.SetLoadFields(Description);
        if KeyTest.FindSet() then
            repeat
                Message('%1', KeyTest."No.");
            until KeyTest.Next() = 0;
    end;

    procedure FilterOnFlowFilterAndSystemId()
    var
        KeyTest: Record "Key Test Table";
    begin
        // A FlowFilter is not a table column and has no index: it parameterises
        // FlowField calculation. SystemId carries its own unique index. Neither
        // can cause the table scan this detector warns about.
        KeyTest.SetRange("Date Filter", 0D, Today());
        KeyTest.SetRange(SystemId, CreateGuid());
        if KeyTest.FindSet() then
            repeat
            until KeyTest.Next() = 0;
    end;
}
