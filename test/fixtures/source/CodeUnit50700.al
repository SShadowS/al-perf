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
}
