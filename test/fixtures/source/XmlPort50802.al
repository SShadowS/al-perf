xmlport 50802 "Slow XmlPort"
{
    schema
    {
        textelement(Root)
        {
            tableelement(CustLedgerEntry; "Cust. Ledger Entry")
            {
                trigger OnAfterGetRecord()
                var
                    Customer: Record Customer;
                begin
                    // Same shape as a report dataitem: OnAfterGetRecord runs
                    // once per row of "Cust. Ledger Entry" with no
                    // repeat/for/foreach/while anywhere in the source.
                    CustLedgerEntry.CalcFields(Amount);
                    Customer.Get(CustLedgerEntry."Customer No.");
                end;
            }
        }
    }
}
