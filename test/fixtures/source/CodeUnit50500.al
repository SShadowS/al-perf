codeunit 50500 "CalcField Loop Test"
{
    procedure ProcessWithSumCalcField()
    var
        TestRec: Record "CalcField Test Table";
    begin
        TestRec.SetRange("No.", 'TEST');
        if TestRec.FindSet() then
            repeat
                TestRec.CalcFields("Total Amount");
            until TestRec.Next() = 0;
    end;

    procedure ProcessWithLookupCalcFieldOnly()
    var
        LookupRec: Record "Lookup Only Table";
    begin
        LookupRec.SetRange("No.", 'TEST');
        if LookupRec.FindSet() then
            repeat
                LookupRec.CalcFields("Customer Name");
            until LookupRec.Next() = 0;
    end;

    trigger OnRun()
    begin
        ProcessWithSumCalcField();
    end;
}
