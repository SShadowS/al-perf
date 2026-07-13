report 50902 "Implicit Rec Report"
{
    UsageCategory = ReportsAndAnalysis;
    ApplicationArea = All;

    dataset
    {
        dataitem(CustLedgerEntry; "Cust. Ledger Entry")
        {
            trigger OnAfterGetRecord()
            begin
                // Bare call, no receiver. The implicit record here is the
                // dataitem instance CustLedgerEntry -- NOT the literal
                // identifier "Rec"; reports/XMLports have no variable
                // actually named Rec. Pins the correction to Task 7's review:
                // defaulting this to "Rec" would silently break downstream
                // variable resolution (SetLoadFields coverage, table lookup)
                // for every bare call in report/XMLport code.
                CalcFields(Amount);
            end;
        }
    }
}
