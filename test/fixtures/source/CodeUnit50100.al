codeunit 50100 "Test Codeunit"
{
    procedure ProcessRecords()
    var
        SalesLine: Record "Sales Line";
    begin
        SalesLine.SetRange("Document No.", 'TEST');
        if SalesLine.FindSet() then
            repeat
                SalesLine.CalcFields(Amount);
                SalesLine.Modify();
            until SalesLine.Next() = 0;
    end;

    procedure SimpleMethod()
    begin
        Message('Hello');
    end;

    trigger OnRun()
    begin
        ProcessRecords();
    end;
}
