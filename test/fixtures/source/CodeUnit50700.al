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
}
