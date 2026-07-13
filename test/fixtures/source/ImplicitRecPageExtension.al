pageextension 50906 "Implicit Rec Page Ext" extends "Customer Card"
{
    trigger OnAfterGetRecord()
    begin
        // Bare call, no receiver, in a PageExtension's own OnAfterGetRecord --
        // a real BC idiom (base pages can't be modified in place). Pins two
        // gate arms at once: IMPLICIT_RECORD_OBJECT_TYPES must contain
        // "PageExtension" for this op to be collected at all, and
        // PER_ROW_TRIGGERS["PageExtension"] must mark it insideLoop, exactly
        // like the base Page case.
        CalcFields(Balance);
    end;
}
