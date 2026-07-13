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
        NewEntry: Record "Cust. Ledger Entry";
        OldEntry: Record "Cust. Ledger Entry";
    begin
        // A page's OnAfterGetRecord runs once per row RENDERED (tens), not
        // per table row (millions) like a report -- same implicit-loop
        // shape, an order of magnitude cheaper. Severity is dropped a level.
        LedgerEntry.Modify();
        // Insert()/Delete() here pin that insert-in-loop and delete-in-loop
        // inherit the same Page severity downgrade (critical -> warning) as
        // modify-in-loop does.
        NewEntry.Insert();
        OldEntry.Delete();
    end;
}
