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
                LogEntry: Record "Cust. Ledger Entry";
                OldEntry: Record "Cust. Ledger Entry";
            begin
                // OnAfterGetRecord runs once per dataitem row -- there is no
                // repeat/for/foreach/while anywhere in this file. The platform
                // itself is the loop, calling this trigger once per row of
                // "Cust. Ledger Entry" (a million-row table in real BC data).
                CustLedgerEntry.CalcFields(Amount);
                Customer.Get(CustLedgerEntry."Customer No.");
                // Insert()/Delete() here pin that insert-in-loop and
                // delete-in-loop inherit the same implicit-loop explanation
                // (Task 7) as calcfields-in-loop above -- the two most common
                // BC write-in-loop bugs must not be exempt from it.
                LogEntry.Init();
                LogEntry.Insert();
                OldEntry.Delete();
            end;
        }
    }
}
