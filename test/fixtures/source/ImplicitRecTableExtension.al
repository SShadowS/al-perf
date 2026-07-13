tableextension 50905 "Implicit Rec Table Ext" extends Customer
{
    procedure RefreshMyTotal()
    begin
        // Bare calls, no receiver, in a TableExtension procedure -- BC
        // partner/ISV code overwhelmingly lives in extension objects, since
        // base tables can't be modified in place. Before this fix,
        // TableExtension was entirely absent from IMPLICIT_RECORD_OBJECT_TYPES,
        // so these two ops were silently invisible to every detector.
        CalcFields(MyTotal);
        Modify();
    end;
}
