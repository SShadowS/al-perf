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
        // "Orphan Sum" resolves from the extension; "Unseen Base Total" does
        // not resolve at all. Downgrading on the resolved subset alone is a
        // guess about the unresolved one.
        if Driver.FindSet() then
            repeat
                Absent.CalcFields("Orphan Sum", "Unseen Base Total");
            until Driver.Next() = 0;
    end;
}
