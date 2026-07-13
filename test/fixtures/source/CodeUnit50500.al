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

    // "CalcField Test Table" also has a Sum FlowField ("Total Amount") and a
    // Count FlowField ("Line Count") -- but THIS call only asks for the
    // Lookup field "Customer Name". Severity must be rated from the field
    // actually passed to CalcFields, not from the table having an unrelated
    // aggregation FlowField elsewhere.
    procedure ProcessWithLookupFieldOnAggregationTable()
    var
        TestRec: Record "CalcField Test Table";
    begin
        TestRec.SetRange("No.", 'TEST');
        if TestRec.FindSet() then
            repeat
                TestRec.CalcFields("Customer Name");
            until TestRec.Next() = 0;
    end;

    [IntegrationEvent(false, false)]
    local procedure OnBeforeProcessCalcFields(var TestRec: Record "CalcField Test Table")
    begin
    end;

    [BusinessEvent(false)]
    local procedure OnAfterProcessCalcFields()
    begin
    end;

    trigger OnRun()
    begin
        ProcessWithSumCalcField();
    end;
}
