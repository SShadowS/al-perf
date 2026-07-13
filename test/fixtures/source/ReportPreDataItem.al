report 50801 "Report Pre Data Item"
{
    UsageCategory = ReportsAndAnalysis;
    ApplicationArea = All;

    dataset
    {
        dataitem(CustLedgerEntry; "Cust. Ledger Entry")
        {
            trigger OnPreDataItem()
            begin
                // OnPreDataItem runs exactly ONCE, before the dataitem starts
                // iterating rows -- it is NOT a per-row trigger and must not
                // be treated as an implicit loop body.
                CustLedgerEntry.CalcFields(Amount);
            end;
        }
    }
}
