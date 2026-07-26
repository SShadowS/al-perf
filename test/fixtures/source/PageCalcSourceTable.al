page 50904 "Calc Source Table Page"
{
    PageType = List;
    // The implicit `Rec` is a "CalcField Test Table", whose "Customer Name" is
    // a Lookup FlowField -- cheap. Nothing declares `Rec` in a var section, so
    // its table is recoverable only from this property. Without that,
    // calcfields-in-loop cannot type the field and falls back to the
    // conservative `critical` on every CalcFields against an object's own
    // record.
    SourceTable = "CalcField Test Table";

    layout
    {
        area(content)
        {
        }
    }

    trigger OnAfterGetRecord()
    begin
        // Per-row trigger, so this is an implicit loop. A Lookup should rate
        // below a Sum -- and a Page-sourced implicit loop is downgraded one
        // more level again.
        CalcFields("Customer Name");
    end;
}
