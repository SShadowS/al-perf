codeunit 50700 "Field Access Test"
{
    procedure GoodSetLoadFields()
    var
        SalesLine: Record "Sales Line";
    begin
        SalesLine.SetLoadFields("Document No.", Amount);
        SalesLine.SetRange("Document No.", 'TEST');
        if SalesLine.FindSet() then
            repeat
                Message('%1 %2', SalesLine."Document No.", SalesLine.Amount);
            until SalesLine.Next() = 0;
    end;

    procedure BadSetLoadFields()
    var
        SalesLine: Record "Sales Line";
    begin
        SalesLine.SetLoadFields("Document No.");
        SalesLine.SetRange("Document No.", 'TEST');
        if SalesLine.FindSet() then
            repeat
                // Accesses Amount but didn't include it in SetLoadFields
                Message('%1 %2', SalesLine."Document No.", SalesLine.Amount);
            until SalesLine.Next() = 0;
    end;

    procedure NoSetLoadFields()
    var
        SalesLine: Record "Sales Line";
    begin
        SalesLine.SetRange("Document No.", 'TEST');
        if SalesLine.FindSet() then
            repeat
                Message('%1', SalesLine.Amount);
            until SalesLine.Next() = 0;
    end;

    procedure LateSetLoadFields()
    var
        SalesLine: Record "Sales Line";
    begin
        SalesLine.SetRange("Document No.", 'TEST');
        if SalesLine.FindSet() then
            repeat
                Message('%1 %2', SalesLine."Document No.", SalesLine.Amount);
            until SalesLine.Next() = 0;
        // Written below the FindSet it's supposed to help -- at the moment the
        // find ran, no fields were restricted yet. This does not retroactively
        // fix that; it is the ordering bug under test.
        SalesLine.SetLoadFields("Document No.", Amount);
    end;

    procedure BareSetLoadFieldsReset()
    var
        SalesLine: Record "Sales Line";
    begin
        // A bare SetLoadFields() resets to loading ALL fields (Microsoft docs) --
        // it is not a restriction, so it must not suppress the warning either.
        SalesLine.SetLoadFields();
        SalesLine.SetRange("Document No.", 'TEST');
        if SalesLine.FindSet() then
            repeat
                Message('%1', SalesLine.Amount);
            until SalesLine.Next() = 0;
    end;

    procedure RepeatedSetLoadFieldsBetweenFinds()
    var
        SalesLine: Record "Sales Line";
    begin
        // SetLoadFields(A) precedes the FIRST find; SetLoadFields(B) precedes
        // the SECOND find. The earliest restrictive call is the correct
        // anchor for missing-setloadfields: some restriction existed before
        // BOTH finds, so neither should be flagged. Anchoring on the LATEST
        // call instead would evaluate the first find against a SetLoadFields
        // that has not even run yet at that point -- a false positive.
        //
        // This procedure ALSO pins incomplete-setloadfields, which must
        // resolve coverage PER ACCESS (the call in effect at that point),
        // not by anchoring on the EARLIEST call for the whole method: "Document
        // No." is genuinely covered by SetLoadFields(A) before the first read,
        // and Amount is genuinely covered by SetLoadFields(B) before the
        // second read. Anchoring on SetLoadFields(A) alone would flag Amount
        // as missing even though SetLoadFields(B) already covered it by the
        // time that read ran -- a critical false positive on correct code.
        SalesLine.SetLoadFields("Document No.");
        SalesLine.SetRange("Document No.", 'TEST');
        if SalesLine.FindSet() then
            repeat
                Message('%1', SalesLine."Document No.");
            until SalesLine.Next() = 0;
        SalesLine.SetLoadFields(Amount);
        SalesLine.SetRange("Document No.", 'TEST2');
        if SalesLine.FindSet() then
            repeat
                Message('%1', SalesLine.Amount);
            until SalesLine.Next() = 0;
    end;

    procedure SetLoadFieldsSameLineAsFindSet()
    var
        SalesLine: Record "Sales Line";
    begin
        // SetLoadFields and FindSet on the SAME physical line, the
        // restriction written first by column. Comparing line numbers alone
        // treats this as "equal" and wrongly flags it; comparing
        // (line, column) resolves the tie correctly.
        SalesLine.SetLoadFields("Document No."); if SalesLine.FindSet() then Message('%1', SalesLine."Document No.");
    end;

    procedure FieldAccessBeforeSetLoadFields()
    var
        SalesLine: Record "Sales Line";
    begin
        // Amount is accessed BEFORE any SetLoadFields call runs -- whatever
        // loaded it, it wasn't this method's later, narrower SetLoadFields.
        // That earlier access must not count against this SetLoadFields
        // call's completeness; only the "Document No." access after it
        // (inside the loop) is in scope, and it IS covered.
        Message('%1', SalesLine.Amount);
        SalesLine.SetLoadFields("Document No.");
        SalesLine.SetRange("Document No.", 'TEST');
        if SalesLine.FindSet() then
            repeat
                Message('%1', SalesLine."Document No.");
            until SalesLine.Next() = 0;
    end;

    procedure BareResetReplacesEarlierSetLoadFields()
    var
        SalesLine: Record "Sales Line";
    begin
        // SetLoadFields("Document No.") narrows to one field; a LATER bare
        // SetLoadFields() resets to loading ALL fields before Amount is
        // accessed. The bare reset -- not the earlier, no-longer-in-effect
        // narrower call -- governs that access, so Amount is genuinely
        // covered. Anchoring on the earliest call for the whole method
        // (rather than resolving coverage per access) would still blame
        // Amount on SetLoadFields("Document No.") and flag it as missing.
        SalesLine.SetLoadFields("Document No.");
        SalesLine.SetRange("Document No.", 'TEST');
        if SalesLine.FindSet() then
            repeat
                Message('%1', SalesLine."Document No.");
            until SalesLine.Next() = 0;
        SalesLine.SetLoadFields();
        SalesLine.SetRange("Document No.", 'TEST2');
        if SalesLine.FindSet() then
            repeat
                Message('%1', SalesLine.Amount);
            until SalesLine.Next() = 0;
    end;
}
