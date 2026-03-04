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
}
