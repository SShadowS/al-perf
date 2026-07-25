page 50903 "Implicit Rec Page"
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
    begin
        // Bare call, no receiver, in a Page's OnAfterGetRecord -- the
        // implicit record here genuinely is "Rec" (a Page has no dataitem
        // wrapper, unlike Report/XMLport). Pins both gate arms at once: the
        // object-type gate (IMPLICIT_RECORD_OBJECT_TYPES must contain
        // "Page", not just "Table"/"Report"/"XMLport") and the per-row
        // trigger gate (PER_ROW_TRIGGERS["Page"] must still mark this
        // insideLoop, unbroken by adding the implicit-Rec collection).
        CalcFields(Balance);
    end;

    procedure PositionOnFirstEntry()
    begin
        // A Page's `Rec` is already filtered by SourceTableView, by whatever
        // the caller passed through SetTableView, and by the user's filter
        // pane. None of that is visible here, so "this queries all records in
        // the table" is a claim this file cannot support.
        if Rec.FindFirst() then;
    end;
}
