codeunit 50976 "SetLoadFields Merge Probe"
{
    procedure ReadsExtensionFieldAfterNarrowing()
    var
        MergeBase: Record "Merge Base";
    begin
        // "Ext Code" is a real field, declared by tableextension 50971. It is
        // not in the SetLoadFields list, so this is a genuine finding — and
        // now a confirmable one.
        MergeBase.SetLoadFields(Description);
        if MergeBase.FindFirst() then
            Message('%1', MergeBase."Ext Code");
    end;

    procedure ReadsExtensionFlowFieldAfterNarrowing()
    var
        MergeBase: Record "Merge Base";
    begin
        // "Ext Lookup" is a FlowField. SetLoadFields does not accept
        // FlowFields, so "add it to SetLoadFields" would not compile.
        MergeBase.SetLoadFields(Description);
        if MergeBase.FindFirst() then
            Message('%1', MergeBase."Ext Lookup");
    end;

    procedure ReadsPrimaryKeyAfterNarrowing()
    var
        MergeBase: Record "Merge Base";
    begin
        // BC always loads the primary key; reading it back is not a forgotten
        // field. The PK must come from the ROOT, not from keys[0] of a merged
        // list that an extension also contributed to.
        MergeBase.SetLoadFields(Description);
        if MergeBase.FindFirst() then
            Message('%1', MergeBase."No.");
    end;

    procedure ReadsFragmentFieldAfterNarrowing()
    var
        Absent: Record "Merge Absent";
    begin
        // "Orphan Code" is confirmed a field by the extension, even though the
        // root was never indexed.
        Absent.SetLoadFields("Orphan Sum");
        if Absent.FindFirst() then
            Message('%1', Absent."Orphan Code");
    end;

    procedure ReadsUnknownNameOnFragmentAfterNarrowing()
    var
        Absent: Record "Merge Absent";
    begin
        // Not in the fragment. Could be an un-narrowed base field or a
        // paren-less base method call — indistinguishable, so the finding
        // stands but stops claiming certainty.
        Absent.SetLoadFields("Orphan Code");
        if Absent.FindFirst() then
            Message('%1', Absent.SomethingUnseen);
    end;

    procedure ReadsAlphaOnlyOnAmbiguousTable()
    var
        Ambig: Record "Merge Ambig";
    begin
        // Two distinct roots both declare "Merge Ambig" -- the merged entry
        // is ambiguous and must answer nothing, even though the winning
        // root's own field ("AlphaOnly") survives on the entry. Treated
        // exactly as an absent table: hedged warning, not critical.
        Ambig.SetLoadFields("No.");
        if Ambig.FindFirst() then
            Message('%1', Ambig.AlphaOnly);
    end;

    procedure ReadsExtensionFlowFilterAfterNarrowing()
    var
        MergeBase: Record "Merge Base";
    begin
        // A FlowFilter is not a loadable column either — SetLoadFields does
        // not accept one, so suggesting it produces code that will not build.
        MergeBase.SetLoadFields(Description);
        if MergeBase.FindFirst() then
            Message('%1', MergeBase."Ext Date Filter");
    end;

    procedure ReadsUntypedFlowFieldAfterNarrowing()
    var
        MergeBase: Record "Merge Base";
    begin
        // The FlowField's CalcFormula could not be typed, so `calcFormulaType`
        // is undefined — but it is still a FlowField, and SetLoadFields still
        // does not accept it.
        MergeBase.SetLoadFields(Description);
        if MergeBase.FindFirst() then
            Message('%1', MergeBase."Ext Unresolved FlowField");
    end;
}
