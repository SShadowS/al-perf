codeunit 50300 "Dangerous Patterns"
{
    procedure CommitInLoop()
    var
        SalesLine: Record "Sales Line";
    begin
        SalesLine.FindSet();
        repeat
            SalesLine.Modify();
            Commit();
        until SalesLine.Next() = 0;
    end;

    procedure ErrorInLoop()
    var
        SalesLine: Record "Sales Line";
    begin
        SalesLine.FindSet();
        repeat
            if SalesLine.Quantity = 0 then
                Error('Quantity cannot be zero');
        until SalesLine.Next() = 0;
    end;

    procedure SafeCommit()
    begin
        // Commit outside loop is fine
        Commit();
    end;
}
