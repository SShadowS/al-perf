report 50800 "Slow Report"
{
    UsageCategory = ReportsAndAnalysis;
    ApplicationArea = All;

    dataset
    {
        dataitem(CustLedgerEntry; "Cust. Ledger Entry")
        {
            trigger OnAfterGetRecord()
            var
                Customer: Record Customer;
            begin
                // OnAfterGetRecord runs once per dataitem row -- there is no
                // repeat/for/foreach/while anywhere in this file. The platform
                // itself is the loop, calling this trigger once per row of
                // "Cust. Ledger Entry" (a million-row table in real BC data).
                CustLedgerEntry.CalcFields(Amount);
                Customer.Get(CustLedgerEntry."Customer No.");
            end;
        }
    }
}
