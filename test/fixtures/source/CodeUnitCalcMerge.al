codeunit 50975 "CalcFields Merge Probe"
{
    procedure CalcExtFlowFieldOnRootSeenTable(var Driver: Record "Test Table")
    var
        MergeBase: Record "Merge Base";
    begin
        // "Ext Lookup" is declared by the tableextension. Its CalcFormula is a
        // Lookup, which is cheaper than Sum/Count, so severity may graduate —
        // the root IS indexed, so the picture is trustworthy.
        if Driver.FindSet() then
            repeat
                MergeBase.CalcFields("Ext Lookup");
            until Driver.Next() = 0;
    end;

    procedure BareCalcFieldsOnFragment(var Driver: Record "Test Table")
    var
        Absent: Record "Merge Absent";
    begin
        // No arguments: the fallback is "every FlowField on the table", and on
        // a fragment that is not the runtime set.
        if Driver.FindSet() then
            repeat
                Absent.CalcFields();
            until Driver.Next() = 0;
    end;

    procedure PartlyResolvedCalcFieldsOnFragment(var Driver: Record "Test Table")
    var
        Absent: Record "Merge Absent";
    begin
        // "Orphan Lookup" resolves from the extension; "Unseen Base Total"
        // does not resolve at all. Downgrading on the resolved subset alone
        // is a guess about the unresolved one. Deliberately a Lookup (not
        // "Orphan Sum"): a Sum in the resolved subset would keep severity
        // critical even with the fence removed, masking a fence deletion.
        if Driver.FindSet() then
            repeat
                Absent.CalcFields("Orphan Lookup", "Unseen Base Total");
            until Driver.Next() = 0;
    end;

    procedure CalcFieldsOnAmbiguousFragment(var Driver: Record "Test Table")
    var
        Ambig: Record "Merge Ambig";
    begin
        // Two distinct roots both declare "Merge Ambig" -- the merged entry
        // is ambiguous and must answer nothing, even though the winning
        // root's fields (including this Lookup) survive on the entry.
        if Driver.FindSet() then
            repeat
                Ambig.CalcFields("Ambig Lookup");
            until Driver.Next() = 0;
    end;

    procedure BareCalcFieldsOnLookupOnlyFragment(var Driver: Record "Test Table")
    var
        LookupOnly: Record "Merge Absent Lookup";
    begin
        // The only FlowField ever seen on this fragment is a Lookup -- no
        // Sum/Count anywhere in the picture. Without the rootSeen fence, the
        // bare-call fallback would resolve to that Lookup-only set and
        // downgrade to warning; the unseen root may still declare a Sum.
        if Driver.FindSet() then
            repeat
                LookupOnly.CalcFields();
            until Driver.Next() = 0;
    end;
}
