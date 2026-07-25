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
}
