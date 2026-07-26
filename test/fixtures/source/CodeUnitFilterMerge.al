codeunit 50977 "Unindexed Filter Merge Probe"
{
    procedure FiltersOnExtensionKeyLeadingField()
    var
        MergeBase: Record "Merge Base";
    begin
        // "Ext Code" leads key ByExtCode2, declared by tableextension 50971.
        // Before the merge that key was invisible and this raised a false
        // "no supporting key" finding.
        MergeBase.SetRange("Ext Code", 'X');
        if MergeBase.FindSet() then;
    end;

    procedure FiltersOnExtensionFlowFilter()
    var
        MergeBase: Record "Merge Base";
    begin
        // A FlowFilter is not a table column and has no index by definition,
        // so it cannot cause the scan being warned about. Declared by the
        // extension, so it only resolves through the merge.
        MergeBase.SetRange("Ext Date Filter", 0D);
        if MergeBase.FindSet() then;
    end;

    procedure FiltersOnUnindexedFieldOfRootSeenTable()
    var
        MergeBase: Record "Merge Base";
    begin
        // Description leads no key on the root or on any indexed extension.
        MergeBase.SetRange(Description, 'X');
        if MergeBase.FindSet() then;
    end;

    procedure FiltersOnFragmentTable()
    var
        Absent: Record "Merge Absent";
    begin
        // The root was never indexed, so "no key leads with this field" is
        // unanswerable — an unseen root key could lead with it.
        Absent.SetRange("Orphan Sum", 0);
        if Absent.FindSet() then;
    end;

    procedure FiltersOnAmbiguousTable()
    var
        Ambig: Record "Merge Ambig";
    begin
        // Two roots named "Merge Ambig" are two different tables (see
        // TableMergeAmbigA.al / TableMergeAmbigB.al). The winning root's
        // fields and keys survive the merge and look plausible, but neither
        // answer is about the table actually in hand, so this must not be
        // judged at all — not flagged, not suppressed on real grounds.
        Ambig.SetRange(AlphaOnly, 'X');
        if Ambig.FindSet() then;
    end;
}
