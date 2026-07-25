#if CLOUD
table 50980 "Guarded Table"
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Description; Text[100]) { }
    }

    keys
    {
        key(PK; "No.") { }
    }

    procedure ScanEverything()
    var
        Guarded: Record "Guarded Table";
    begin
        // A whole file wrapped in #if was dropped before the declaration was
        // ever found, so nothing in it could be analyzed at all.
        if Guarded.FindSet() then
            repeat
            until Guarded.Next() = 0;
    end;
}
#endif
