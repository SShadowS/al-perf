codeunit 50400 "Temp Table Patterns"
{
    procedure ProcessWithTempTable()
    var
        TempBuffer: Record "Sales Line" temporary;
    begin
        TempBuffer.FindSet();
        repeat
            TempBuffer.CalcFields(Amount);
            TempBuffer.Modify();
        until TempBuffer.Next() = 0;
    end;

    procedure ProcessWithRealTable()
    var
        SalesLine: Record "Sales Line";
    begin
        SalesLine.FindSet();
        repeat
            SalesLine.CalcFields(Amount);
        until SalesLine.Next() = 0;
    end;

    procedure ProcessTempWithIncompleteSetLoadFields()
    var
        TempBuffer: Record "Sales Line" temporary;
    begin
        // SetLoadFields is a no-op on a temporary record -- no SQL load
        // happens -- so an "incomplete" SetLoadFields on a temp variable is
        // not a real problem, regardless of what fields are later accessed.
        TempBuffer.SetLoadFields("Document No.");
        TempBuffer.FindSet();
        repeat
            Message('%1 %2', TempBuffer."Document No.", TempBuffer.Amount);
        until TempBuffer.Next() = 0;
    end;
}
