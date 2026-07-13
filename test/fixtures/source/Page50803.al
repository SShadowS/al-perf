page 50803 "Slow Page"
{
    PageType = List;
    SourceTable = "Cust. Ledger Entry";

    layout
    {
        area(content)
        {
        }
    }

    trigger OnAfterGetRecord()
    var
        LedgerEntry: Record "Cust. Ledger Entry";
    begin
        // A page's OnAfterGetRecord runs once per row RENDERED (tens), not
        // per table row (millions) like a report -- same implicit-loop
        // shape, an order of magnitude cheaper. Severity is dropped a level.
        LedgerEntry.Modify();
    end;
}
