report 50908 "Implicit Rec Report Global"
{
    UsageCategory = ReportsAndAnalysis;
    ApplicationArea = All;

    procedure GlobalHelper()
    begin
        // Bare call, no receiver, OUTSIDE any dataitem. A report's implicit
        // record is the dataitem's own name -- there is no dataitem in scope
        // here, so there is no implicit record at all. Must NOT be collected
        // against a phantom "Rec" that doesn't exist in a report.
        Count();
    end;
}
